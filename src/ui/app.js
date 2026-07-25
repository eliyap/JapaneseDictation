import { Session } from "../core/session.js";
import {
  listSchedulers, getScheduler, defaultParams, resolveParams,
} from "../core/scheduler/index.js";
import { GitHubSqliteStore, newId } from "../adapters/storage/github-sqlite.js";
import { ContentsApi } from "../adapters/github/contents-api.js";
import { createElevenLabs } from "../adapters/tts/elevenlabs.js";
import { createWebSpeech } from "../adapters/tts/webspeech.js";
import { Player } from "../adapters/tts/player.js";
import {
  loadConfig, saveConfig, clearConfig, githubReady, ttsReady, PARAMS_SETTING_KEY,
  parseCredentialBlob, buildCredentialBlob, CREDENTIAL_USER,
} from "./config.js";

const $ = (id) => document.getElementById(id);
const SQL_OPTS = { locateFile: (f) => new URL(`../vendor/${f}`, import.meta.url).href };
const FLUSH_DELAY = 8000; // batch a burst of answers into one commit

const app = {
  cfg: loadConfig(),
  store: null,
  session: null,
  player: null,
  view: "review",
  flushTimer: null,
  busy: false,
};

// ==========================================================================
// boot
// ==========================================================================

async function boot() {
  wireChrome();
  wireReview();
  wireSentences();
  wireSettings();
  fillSettings();
  buildSchedulerControls();

  if (!githubReady(app.cfg)) {
    show("settings");
    setSync("locked");
    toast("Unlock with your credential JSON to begin", { ms: 4000 });
    $("credBlob").focus(); // prompts the password manager to offer autofill
    return;
  }
  await connect();
}

async function connect() {
  setSync("loading…", "busy");
  try {
    app.store = new GitHubSqliteStore({
      ...app.cfg.github,
      sqlOpts: SQL_OPTS,
      onStatus: ({ state, detail }) => setSync(detail ? `${state} — ${detail}` : state,
        state === "error" ? "err" : state === "saved" || state === "loaded" ? "" : "busy"),
    });
    await app.store.load();
  } catch (e) {
    setSync("offline", "err");
    toast(e.message, { error: true, ms: 6000 });
    show("settings");
    return;
  }

  const schedulerId = app.store.getSetting("scheduler") ?? app.cfg.schedulerId;
  app.session = new Session({ store: app.store, schedulerId, params: storedParams(schedulerId) });
  app.cfg.schedulerId = schedulerId;
  saveConfig(app.cfg);

  buildPlayer();
  buildSchedulerControls();
  setSync("synced");
  render();
}

function storedParams(schedulerId) {
  if (!app.store) return {};
  try {
    return JSON.parse(app.store.getSetting(PARAMS_SETTING_KEY(schedulerId)) ?? "{}");
  } catch {
    return {};
  }
}

function buildPlayer() {
  const tts = createElevenLabs({ ...app.cfg.elevenlabs, apiKey: app.cfg.elevenlabs.apiKey });
  const fallback = createWebSpeech();
  if (app.player) app.player.release();
  app.player = new Player({ tts, fallback });
}

// ==========================================================================
// review
// ==========================================================================

function wireReview() {
  $("play").addEventListener("click", play);
  $("reveal").addEventListener("click", reveal);
  $("right").addEventListener("click", () => answer(true));
  $("wrong").addEventListener("click", () => answer(false));
  $("slower").addEventListener("click", () => nudge(-0.05));
  $("faster").addEventListener("click", () => nudge(+0.05));
}

function render() {
  if (!app.session) return;

  const counts = app.session.counts();
  $("dueBadge").textContent = counts.due > 0 ? String(counts.due) : "";

  const cur = app.session.current() ?? app.session.next();
  const hasCard = Boolean(cur);

  $("reviewCard").hidden = !hasCard;
  $("reviewEmpty").hidden = hasCard;
  $("actions").hidden = !hasCard || app.view !== "review";

  if (!hasCard) {
    const done = counts.total === 0;
    $("emptyTitle").textContent = done ? "No sentences yet" : "Nothing due";
    $("emptyBody").textContent = done
      ? "Add some on the Sentences tab."
      : `${counts.retired} retired · ${counts.waiting} waiting for their next review.`;
    return;
  }

  renderSpeed(cur.state.speed);
  const revealed = app.session.revealed;
  $("answerBlock").hidden = !revealed;
  $("reveal").hidden = revealed;
  $("gradeRow").hidden = !revealed;

  if (revealed) {
    $("answerText").textContent = cur.sentence.text;
    $("answerTranslation").textContent = cur.sentence.translation ?? "";
    $("answerNotes").textContent = cur.sentence.notes ?? "";
  }
}

function renderSpeed(speed) {
  const p = app.session.params;
  const lo = p.minSpeed ?? 0.5;
  const hi = p.maxSpeed ?? 1.1;
  $("speed").textContent = `${Math.round(speed * 100)}%`;
  $("speedFill").style.width = `${((speed - lo) / (hi - lo)) * 100}%`;
  $("slower").disabled = speed <= lo + 1e-9;
  $("faster").disabled = speed >= hi - 1e-9;
}

async function play() {
  const cur = app.session?.current();
  if (!cur || app.busy) return;

  if (!ttsReady(app.cfg)) {
    note("No ElevenLabs key — using the device voice. Add one in Settings.", false);
  }

  app.busy = true;
  $("play").classList.add("playing");
  $("playLabel").textContent = app.player.hasAudio ? "Playing" : "Generating…";
  try {
    await app.player.play(cur.sentence, cur.state.speed);
    note(app.player.usingFallback ? "device voice (ElevenLabs unavailable)" : "", false);
  } catch (e) {
    note(e.message, true);
  } finally {
    app.busy = false;
    $("play").classList.remove("playing");
    $("playLabel").textContent = "Play";
  }
}

function nudge(delta) {
  const state = app.session?.nudgeSpeed(delta);
  if (!state) return;
  renderSpeed(state.speed);
  app.player.setRate(state.speed); // takes effect mid-playback
  scheduleFlush();
}

function reveal() {
  app.session.reveal();
  render();
}

function answer(correct) {
  app.session.answer(correct);
  app.player.release(); // this card's audio is done with
  note("", false);
  app.session.next();
  render();
  scheduleFlush();
  if (app.cfg.autoPlay) play();
}

const note = (msg, isError) => {
  $("playNote").textContent = msg;
  $("playNote").classList.toggle("err", Boolean(isError));
};

// ==========================================================================
// sentences
// ==========================================================================

function wireSentences() {
  $("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("newText").value.trim();
    if (!text || !app.store) return;

    app.store.upsertSentence({
      id: newId(),
      text,
      translation: $("newTranslation").value.trim(),
      notes: "",
      tags: $("newTags").value.split(",").map((t) => t.trim()).filter(Boolean),
      createdAt: Date.now(),
      archived: false,
    });
    $("newText").value = "";
    $("newTranslation").value = "";
    $("newTags").value = "";
    $("newText").focus();
    renderList();
    render();
    scheduleFlush();
    toast("Added");
  });

  $("filter").addEventListener("input", renderList);
}

function renderList() {
  if (!app.store) return;
  const q = $("filter").value.trim().toLowerCase();
  const all = app.store.listSentences();
  const shown = q
    ? all.filter((s) =>
        s.text.toLowerCase().includes(q) ||
        (s.translation ?? "").toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)))
    : all;

  $("listCount").textContent = q ? `${shown.length}/${all.length}` : `${all.length}`;

  const list = $("sentenceList");
  list.replaceChildren();
  for (const s of shown) {
    const card = app.store.getCard(s.id);
    const li = document.createElement("li");
    li.className = s.archived ? "archived" : "";

    const row = document.createElement("div");
    row.className = "row";

    const txt = document.createElement("div");
    txt.className = "txt";
    const jp = document.createElement("p");
    jp.className = "jp";
    jp.lang = "ja";
    jp.textContent = s.text;
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = [
      s.translation,
      card ? `${Math.round(card.speed * 100)}% · ${card.reps} rep${card.reps === 1 ? "" : "s"}` : "new",
      card?.retired ? "retired" : null,
      s.tags.join(" "),
    ].filter(Boolean).join(" · ");
    txt.append(jp, sub);

    const kill = document.createElement("button");
    kill.className = "kill";
    kill.type = "button";
    kill.textContent = "🗑";
    kill.setAttribute("aria-label", `Delete: ${s.text}`);
    kill.addEventListener("click", () => {
      if (!confirm(`Delete this sentence?\n\n${s.text}`)) return;
      app.store.deleteSentence(s.id);
      renderList();
      render();
      scheduleFlush();
    });

    row.append(txt, kill);
    li.append(row);
    list.append(li);
  }
}

// ==========================================================================
// settings
// ==========================================================================

function wireSettings() {
  const bind = (id, apply) => $(id).addEventListener("change", () => {
    apply($(id).value.trim());
    saveConfig(app.cfg);
  });

  bind("ghOwner", (v) => (app.cfg.github.owner = v));
  bind("ghRepo", (v) => (app.cfg.github.repo = v));
  bind("ghBranch", (v) => (app.cfg.github.branch = v || "main"));
  bind("ghPath", (v) => (app.cfg.github.path = v || "data/dictation.sqlite"));
  bind("elVoice", (v) => { app.cfg.elevenlabs.voiceId = v; buildPlayer(); });
  bind("elModel", (v) => { app.cfg.elevenlabs.modelId = v; buildPlayer(); });

  wireCredentials();

  $("testGh").addEventListener("click", testGitHub);
  $("testEl").addEventListener("click", testElevenLabs);
  $("syncNow").addEventListener("click", () => flush({ manual: true }));
  $("resetParams").addEventListener("click", () => saveParams({}, true));

  $("forgetCreds").addEventListener("click", () => {
    if (!confirm("Remove the GitHub token and ElevenLabs key from this device?")) return;
    clearConfig();
    app.cfg = loadConfig();
    fillSettings();
    toast("Credentials cleared");
  });

  $("schedulerPick").addEventListener("change", async () => {
    const id = $("schedulerPick").value;
    app.cfg.schedulerId = id;
    saveConfig(app.cfg);
    if (app.store) {
      app.store.setSetting("scheduler", id);
      app.session.setScheduler(id, storedParams(id));
      scheduleFlush();
    }
    buildSchedulerControls();
    render();
  });
}

function fillSettings() {
  $("credUser").value = CREDENTIAL_USER;
  $("ghOwner").value = app.cfg.github.owner;
  $("ghRepo").value = app.cfg.github.repo;
  $("ghBranch").value = app.cfg.github.branch;
  $("ghPath").value = app.cfg.github.path;
  $("elVoice").value = app.cfg.elevenlabs.voiceId;
  $("elModel").value = app.cfg.elevenlabs.modelId;
  // The blob field stays empty on purpose: it is an input for the password
  // manager to fill, not a place to display the secrets back.
}

function wireCredentials() {
  $("credForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const blob = $("credBlob").value.trim();
    if (!blob) {
      // Tapping Unlock blurs the field first, so the change handler below may
      // already have consumed and cleared it. Only complain if that did not
      // actually leave us configured.
      if (!githubReady(app.cfg) && !ttsReady(app.cfg)) {
        $("credResult").className = "result err";
        $("credResult").textContent = "Paste your credential JSON first";
      }
      return;
    }
    await applyCredentials(blob);
  });

  // A manager that autofills without a submit still gets picked up.
  $("credBlob").addEventListener("change", () => {
    const v = $("credBlob").value.trim();
    if (v.startsWith("{")) applyCredentials(v);
  });

  $("copyCreds").addEventListener("click", async () => {
    const blob = buildCredentialBlob(app.cfg);
    try {
      await navigator.clipboard.writeText(blob);
      toast("Credential JSON copied");
    } catch {
      // Clipboard is blocked without a secure context or permission; showing
      // the text is still useful, and it is the user's own secret.
      $("credBlob").value = blob;
      toast("Copy failed — shown in the field instead", { error: true });
    }
  });
}

async function applyCredentials(text) {
  const el = $("credResult");
  el.className = "result";
  try {
    const patch = parseCredentialBlob(text);
    app.cfg.github = { ...app.cfg.github, ...patch.github };
    app.cfg.elevenlabs = { ...app.cfg.elevenlabs, ...patch.elevenlabs };
    saveConfig(app.cfg);
    fillSettings();
    buildPlayer();

    el.className = "result ok";
    el.textContent = "Credentials loaded";
    $("credBlob").value = "";

    if (githubReady(app.cfg)) await connect();
  } catch (err) {
    el.className = "result err";
    el.textContent = err.message;
  }
}

/** Renders the algorithm picker and its parameter fields from the scheduler's
 *  own declarations, so a newly registered algorithm needs no UI work. */
function buildSchedulerControls() {
  const pick = $("schedulerPick");
  const active = app.session?.scheduler ?? getScheduler(app.cfg.schedulerId);

  pick.replaceChildren();
  for (const s of listSchedulers()) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    opt.selected = s.id === active.id;
    pick.append(opt);
  }
  $("schedulerDesc").textContent = active.description ?? "";

  const values = app.session?.params ?? resolveParams(active, {});
  const box = $("paramFields");
  box.replaceChildren();

  for (const spec of active.params) {
    const label = document.createElement("label");
    label.textContent = spec.label + (spec.unit === "days" ? " (days)" : "");

    const input = document.createElement("input");
    input.id = `param-${spec.key}`;
    if (spec.type === "boolean") {
      input.type = "checkbox";
      input.checked = Boolean(values[spec.key]);
      input.style.width = "auto";
    } else {
      input.type = "number";
      input.value = String(values[spec.key]);
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      if (spec.step !== undefined) input.step = String(spec.step);
    }
    input.addEventListener("change", () => {
      const next = { ...(app.session?.params ?? {}) };
      next[spec.key] = spec.type === "boolean" ? input.checked : input.value;
      const resolved = saveParams(next);
      // Reflect any clamping by writing back to this one input. Rebuilding the
      // whole panel here would tear out the element whose change event we are
      // still inside, which throws.
      if (resolved && spec.type !== "boolean") input.value = String(resolved[spec.key]);
    });

    label.append(input);
    if (spec.help) {
      const help = document.createElement("span");
      help.className = "muted small";
      help.textContent = spec.help;
      label.append(help);
    }
    box.append(label);
  }
}

/** @returns {Record<string, any>|null} the params actually applied */
function saveParams(raw, reset = false) {
  if (!app.session || !app.store) return null;
  const scheduler = app.session.scheduler;
  const resolved = reset ? defaultParams(scheduler) : resolveParams(scheduler, raw);
  app.session.params = resolved;
  app.store.setSetting(PARAMS_SETTING_KEY(scheduler.id), JSON.stringify(resolved));
  // Only a reset rebuilds the panel; it is driven from a button, so no input
  // is mid-event when the fields are replaced.
  if (reset) buildSchedulerControls();
  render();
  scheduleFlush();
  return resolved;
}

async function testGitHub() {
  const el = $("ghResult");
  el.className = "result";
  el.textContent = "Checking…";
  try {
    const api = new ContentsApi(app.cfg.github);
    const info = await api.checkAccess();
    el.className = "result ok";
    el.textContent =
      `${info.fullName} · ${info.private ? "private" : "public"} · ` +
      `${info.canPush ? "can write" : "READ ONLY — sync will fail"}`;
    if (!app.store) await connect();
  } catch (e) {
    el.className = "result err";
    el.textContent = e.message;
  }
}

async function testElevenLabs() {
  const el = $("elResult");
  el.className = "result";
  el.textContent = "Requesting a sample…";
  try {
    const tts = createElevenLabs(app.cfg.elevenlabs);
    const blob = await tts.synthesize("テストです。", {});
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
    await audio.play();
    el.className = "result ok";
    el.textContent = `Working — ${(blob.size / 1024).toFixed(0)} KB`;
  } catch (e) {
    el.className = "result err";
    el.textContent = e.message;
  }
}

// ==========================================================================
// sync
// ==========================================================================

function scheduleFlush() {
  clearTimeout(app.flushTimer);
  app.flushTimer = setTimeout(() => flush(), FLUSH_DELAY);
  setSync("unsaved changes");
}

async function flush({ manual = false } = {}) {
  clearTimeout(app.flushTimer);
  if (!app.store) return;
  if (!app.store.isDirty()) {
    if (manual) toast("Nothing to sync");
    return;
  }
  try {
    const res = await app.store.flush();
    if (res.pushed) setSync(res.merged ? "synced (merged)" : "synced");
    if (manual) toast(res.merged ? "Synced — merged with remote" : "Synced");
    updateDataStats();
  } catch (e) {
    setSync("save failed", "err");
    toast(e.message, { error: true, ms: 6000 });
  }
}

function setSync(text, cls = "") {
  const el = $("sync");
  el.textContent = text;
  el.className = `sync ${cls}`;
}

function updateDataStats() {
  if (!app.store) return;
  const c = app.session?.counts() ?? { total: 0, due: 0, retired: 0 };
  $("dataStats").textContent =
    `${c.total} sentences · ${c.due} due · ${c.retired} retired · ` +
    `${app.store.countReviews()} reviews logged`;
}

// ==========================================================================
// chrome
// ==========================================================================

function wireChrome() {
  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.addEventListener("click", () => show(btn.dataset.view));
  }

  // A phone can kill the tab at any moment; commit before it does. `pagehide`
  // is the one that actually fires on iOS -- `beforeunload` does not.
  addEventListener("pagehide", () => navigator.sendBeacon && flush());
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

function show(view) {
  app.view = view;
  for (const el of document.querySelectorAll(".view")) {
    el.hidden = el.id !== `view-${view}`;
  }
  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
  $("actions").hidden = view !== "review" || !app.session?.current();

  if (view === "sentences") renderList();
  if (view === "settings") { buildSchedulerControls(); updateDataStats(); }
  if (view === "review") render();
}

let toastTimer = null;
function toast(msg, { error = false, ms = 2200 } = {}) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${error ? "err" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

boot();
