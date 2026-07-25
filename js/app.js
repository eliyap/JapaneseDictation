import { grade, pickNext, deckStats, isRetired, SPEED, RETIRE_STREAK } from "./srs.js";
import { isExact, isNearMiss, diffChars } from "./grade.js";
import { loadCards, saveCards, resetAll, exportJSON, importJSON } from "./store.js";
import { Player, warmUpVoices } from "./audio.js";

const $ = (id) => document.getElementById(id);
const el = {
  card: $("card"), done: $("done"), error: $("error"),
  speedLabel: $("speedLabel"), speedFill: $("speedFill"), streakLabel: $("streakLabel"),
  playBtn: $("playBtn"), srcNote: $("srcNote"), answer: $("answer"),
  checkBtn: $("checkBtn"), skipBtn: $("skipBtn"),
  reveal: $("reveal"), verdict: $("verdict"), target: $("target"),
  diff: $("diff"), legend: $("legend"), translation: $("translation"),
  nextBtn: $("nextBtn"), overrideBtn: $("overrideBtn"),
  stats: $("stats"), menu: $("menu"), menuBtn: $("menuBtn"), menuStats: $("menuStats"),
  closeMenu: $("closeMenu"), resetBtn: $("resetBtn"),
  exportBtn: $("exportBtn"), importBtn: $("importBtn"), ioBox: $("ioBox"),
};

const state = {
  sentences: new Map(),
  cards: [],
  current: null,   // card
  phase: "answer", // 'answer' | 'revealed'
  judged: null,    // boolean -- the auto grade, before any override
  applied: null,   // boolean -- what we actually recorded
};

// --------------------------------------------------------------------------

async function boot() {
  warmUpVoices();
  let deck, manifest;
  try {
    deck = await fetchJSON("data/deck.json");
  } catch (e) {
    return fail(`Could not load data/deck.json — ${e.message}`);
  }
  // A missing manifest is the normal state before you generate any audio.
  manifest = await fetchJSON("data/audio-manifest.json").catch(() => ({}));

  const sentences = deck.sentences ?? [];
  if (sentences.length === 0) return fail("data/deck.json contains no sentences.");
  for (const s of sentences) state.sentences.set(s.id, s);

  state.player = new Player(manifest.audio ?? manifest ?? {});
  state.cards = loadCards(sentences);

  wireEvents();
  advance();
}

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function fail(msg) {
  el.error.textContent = msg;
  el.error.hidden = false;
  el.card.hidden = true;
}

// --------------------------------------------------------------------------

function advance() {
  const next = pickNext(state.cards, { exclude: state.current?.id ?? null });
  if (!next) {
    el.card.hidden = true;
    el.done.hidden = false;
    renderStats();
    return;
  }
  state.current = next;
  state.phase = "answer";
  state.judged = null;
  state.applied = null;

  el.done.hidden = true;
  el.card.hidden = false;
  el.reveal.hidden = true;
  el.answer.value = "";
  el.answer.disabled = false;
  el.checkBtn.disabled = false;

  renderSpeed(next);
  renderStats();

  el.srcNote.textContent = state.player.usesSynthFallback(next.id)
    ? "no audio file — using this device's built-in voice"
    : "";

  el.answer.focus();
  play(); // autoplay: you came here to listen
}

function renderSpeed(card) {
  const pct = Math.round(card.speed * 100);
  el.speedLabel.textContent = `${pct}%`;
  const span = SPEED.max - SPEED.min;
  el.speedFill.style.width = `${((card.speed - SPEED.min) / span) * 100}%`;
  el.streakLabel.textContent = card.streak > 0
    ? `${card.streak}/${RETIRE_STREAK} streak`
    : "";
}

function renderStats() {
  const s = deckStats(state.cards);
  const acc = s.accuracy === null ? "—" : `${Math.round(s.accuracy * 100)}%`;
  el.stats.textContent = `${s.retired}/${s.total} retired · ${acc}`;
  el.menuStats.textContent =
    `${s.total} sentences · ${s.active} active · ${s.retired} retired · ` +
    `${s.hits}/${s.attempts} correct (${acc})`;
}

// --------------------------------------------------------------------------

async function play() {
  const card = state.current;
  if (!card) return;
  const sentence = state.sentences.get(card.id);
  el.playBtn.classList.add("playing");
  try {
    await state.player.play(sentence, card.speed);
  } catch (e) {
    // Browsers refuse to make noise before the user has interacted with the
    // page, so the very first autoplay of a session is expected to fail.
    el.srcNote.textContent = /not-allowed|NotAllowedError/i.test(e.message)
      ? "press Play to start — the browser blocks audio until you interact"
      : e.message;
  } finally {
    el.playBtn.classList.remove("playing");
  }
}

function check({ forceWrong = false } = {}) {
  if (state.phase === "revealed") return;
  const card = state.current;
  const sentence = state.sentences.get(card.id);
  const answer = el.answer.value;

  const exact = !forceWrong && isExact(answer, sentence.text);
  const near = !forceWrong && !exact && isNearMiss(answer, sentence.text);

  state.judged = exact;
  applyGrade(exact);
  showReveal({ sentence, answer, exact, near, revealedWithoutTrying: forceWrong });
}

/**
 * Record `correct` for the current card. Always grades from `state.baseline`
 * (the card as it stood before this question), so flipping the override
 * re-derives the result instead of stacking a second adjustment on top.
 */
function applyGrade(correct) {
  if (state.applied === null) state.baseline = state.current;

  const updated = grade(state.baseline, correct);
  const idx = state.cards.findIndex((c) => c.id === updated.id);
  state.cards[idx] = updated;
  state.current = updated;
  state.applied = correct;

  saveCards(state.cards);
  renderSpeed(updated);
  renderStats();
}

function showReveal({ sentence, answer, exact, near, revealedWithoutTrying }) {
  state.phase = "revealed";
  el.answer.disabled = true;
  el.checkBtn.disabled = true;
  el.reveal.hidden = false;

  el.verdict.className = "verdict " + (exact ? "hit" : near ? "near" : "miss");
  el.verdict.textContent = revealedWithoutTrying
    ? "Revealed — counted as a miss"
    : exact
      ? "Word-perfect"
      : near
        ? "Long-vowel marks only — counted as a miss"
        : "Not word-perfect";

  el.target.textContent = sentence.text;
  el.diff.replaceChildren();
  const showDiff = !exact && answer.trim() !== "";
  if (showDiff) {
    for (const part of diffChars(answer, sentence.text)) {
      const span = document.createElement("span");
      span.className = part.type;
      span.textContent = part.text;
      el.diff.append(span);
    }
  }
  el.legend.hidden = !showDiff;
  el.translation.textContent = sentence.translation ?? "";
  updateOverrideButton();
  el.nextBtn.focus();
}

function updateOverrideButton() {
  el.overrideBtn.textContent = state.applied
    ? "Actually, I got it wrong"
    : "Actually, I got it right";
}

function toggleOverride() {
  applyGrade(!state.applied);
  updateOverrideButton();
  el.verdict.className = "verdict " + (state.applied ? "hit" : "miss");
  el.verdict.textContent = state.applied
    ? "Marked correct"
    : "Marked incorrect";
}

// --------------------------------------------------------------------------

function wireEvents() {
  el.playBtn.addEventListener("click", play);
  el.checkBtn.addEventListener("click", () => check());
  el.skipBtn.addEventListener("click", () => check({ forceWrong: true }));
  el.nextBtn.addEventListener("click", advance);
  el.overrideBtn.addEventListener("click", toggleOverride);

  // Enter submits / advances. Shift+Enter is a newline. Crucially, an Enter
  // that closes an IME conversion must not submit -- `isComposing` catches it.
  el.answer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      check();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (el.menu.open) return;

    // Ctrl/Cmd+Space replays from anywhere, including mid-sentence.
    if (e.code === "Space" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      play();
      return;
    }
    // A focused button already turns Enter and Space into a click; handling
    // them here as well would fire the action twice and skip a card.
    if (e.target instanceof HTMLButtonElement) return;

    const typing = e.target === el.answer;

    if (e.key === "Enter" && state.phase === "revealed" && !e.isComposing) {
      e.preventDefault();
      advance();
      return;
    }
    // Bare space replays, but only where it isn't wanted as literal input.
    if (e.code === "Space" && !typing) {
      e.preventDefault();
      play();
    }
  });

  el.menuBtn.addEventListener("click", () => el.menu.showModal());
  el.closeMenu.addEventListener("click", () => el.menu.close());
  el.resetBtn.addEventListener("click", () => {
    if (!confirm("Erase all progress for every sentence?")) return;
    resetAll();
    state.cards = loadCards([...state.sentences.values()]);
    state.current = null;
    el.menu.close();
    advance();
  });
  el.exportBtn.addEventListener("click", () => { el.ioBox.value = exportJSON(); });
  el.importBtn.addEventListener("click", () => {
    try {
      importJSON(el.ioBox.value);
      state.cards = loadCards([...state.sentences.values()]);
      state.current = null;
      el.menu.close();
      advance();
    } catch (e) {
      alert(`Import failed: ${e.message}`);
    }
  });
}

boot();
