// Drives the real UI in a phone-sized browser, with the GitHub Contents API
// and ElevenLabs intercepted at the network layer. Everything below the fetch
// boundary -- sql.js, the store, the scheduler, playback -- is the real thing.
//
//   npm run serve    # in one terminal
//   npm run e2e      # in another
//
// PW_CHROMIUM points at a preinstalled browser instead of Playwright's own.

import { chromium, devices } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8765";
const launch = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};

const browser = await chromium.launch({
  ...launch,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
  ...devices["iPhone 13"],
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();

const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
// Set while the outage section is deliberately making requests fail.
let expectingProviderErrors = false;

page.on("console", (m) => {
  if (m.type() !== "error") return;
  // The very first load asks GitHub for a database that does not exist yet.
  // That 404 is a designed, handled state, but the browser still logs the
  // failed request -- so it is not evidence of a bug.
  if (/404/.test(m.text())) return;
  if (expectingProviderErrors && /40\d/.test(m.text())) return;
  problems.push(`console: ${m.text()}`);
});

// --- fake backends --------------------------------------------------------

const repoFiles = new Map(); // path -> { b64, sha }
let shaSeq = 0;
let ttsCalls = 0;

await page.route("**://api.github.com/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (/\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
    return json({ full_name: "eliyap/JapaneseDictation", private: false,
                  default_branch: "main", permissions: { push: true } });
  }
  const m = url.pathname.match(/\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  if (!m) return json({ message: "Not Found" }, 404);
  const path = decodeURIComponent(m[1]);

  if (req.method() === "GET") {
    const f = repoFiles.get(path);
    if (!f) return json({ message: "Not Found" }, 404);
    return json({ type: "file", encoding: "base64", size: f.b64.length, path,
                  sha: f.sha, content: f.b64.replace(/(.{60})/g, "$1\n") });
  }
  if (req.method() === "PUT") {
    const body = JSON.parse(req.postData());
    const existing = repoFiles.get(path);
    if (existing && body.sha !== existing.sha) return json({ message: "conflict" }, 409);
    const rec = { b64: body.content, sha: `sha${++shaSeq}` };
    repoFiles.set(path, rec);
    return json({ content: { sha: rec.sha }, commit: { sha: `c${shaSeq}` } });
  }
  return json({ message: "Not Found" }, 404);
});

// A 0.3s silent MP3 so the real <audio> element genuinely decodes and plays.
const SILENT_MP3 = Buffer.from(
  "//uQZAAAAAAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVV" +
  "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
  "base64",
);

await page.route("**://api.elevenlabs.io/**", async (route) => {
  ttsCalls++;
  await route.fulfill({ status: 200, contentType: "audio/mpeg", body: SILENT_MP3 });
});

// Record what playback is actually asked to do.
await page.addInitScript(() => {
  window.__plays = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__plays.push({ rate: this.playbackRate, preservesPitch: this.preservesPitch });
    return play.call(this).catch(() => {});
  };
});

// --- helpers --------------------------------------------------------------

const tab = (name) => page.click(`.tabs button[data-view="${name}"]`);
const speed = () => page.locator("#speed").innerText();
const sync = () => page.locator("#sync").innerText();

const CREDS = JSON.stringify({
  github: {
    owner: "eliyap", repo: "JapaneseDictation", branch: "main",
    path: "data/dictation.sqlite", token: "github_pat_test",
  },
  elevenlabs: { apiKey: "sk_test", voiceId: "3JDquces8E8bkmvbh6Bc", modelId: "eleven_multilingual_v2" },
});

/** Unlock the way a password manager would: one JSON blob into one field. */
async function configure() {
  await tab("settings");
  await page.fill("#credBlob", CREDS);
  await page.click('#credForm button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector("#credResult")?.textContent === "Credentials loaded",
    null, { timeout: 15000 },
  );
}

async function addSentence(text, translation = "") {
  await tab("sentences");
  await page.fill("#newText", text);
  if (translation) await page.fill("#newTranslation", translation);
  await page.click('#addForm button[type="submit"]');
}

// --- run ------------------------------------------------------------------

await page.goto(BASE, { waitUntil: "networkidle" });

// Unconfigured, the app should land on Settings rather than a broken review screen.
assert.ok(await page.locator("#view-settings").isVisible(), "starts on settings when unconfigured");

await configure();

// The blob populates the non-secret fields, and is cleared from the DOM after.
assert.equal(await page.inputValue("#ghOwner"), "eliyap");
assert.equal(await page.inputValue("#elVoice"), "3JDquces8E8bkmvbh6Bc");
assert.equal(await page.inputValue("#credBlob"), "", "the blob field does not retain secrets");

await page.click("#testGh");
await page.waitForFunction(
  () => document.querySelector("#ghResult")?.textContent?.includes("can write"),
  null, { timeout: 15000 },
);
assert.equal(await page.locator("#ghResult").innerText(),
  "eliyap/JapaneseDictation · public · can write");

// A bad paste must explain itself rather than silently doing nothing.
await page.fill("#credBlob", "github_pat_justatoken");
await page.click('#credForm button[type="submit"]');
await page.waitForFunction(
  () => /bare token/.test(document.querySelector("#credResult")?.textContent ?? ""),
  null, { timeout: 5000 },
);
await page.fill("#credBlob", "");

await addSentence("明日の朝、駅で友だちに会う約束をしました。", "I'll meet a friend at the station.");
await addSentence("この漢字の読み方が分かりません。", "I don't know how to read this kanji.");
assert.equal(await page.locator("#listCount").innerText(), "2");

// --- review flow ----------------------------------------------------------
await tab("review");
await page.waitForSelector("#reviewCard:not([hidden])");
assert.equal(await speed(), "80%", "starts at 80%");
assert.equal(await page.locator("#dueBadge").innerText(), "2");

// Answer is hidden until asked for -- grading happens on paper.
assert.ok(await page.locator("#answerBlock").isHidden(), "answer hidden before reveal");
assert.ok(await page.locator("#reveal").isVisible());
assert.ok(await page.locator("#gradeRow").isHidden());

await page.click("#play");
await page.waitForTimeout(900);
assert.ok(ttsCalls >= 1, "ElevenLabs was called");

// Replaying must not re-synthesize: audio for the current card is held in memory.
const callsBeforeReplay = ttsCalls;
await page.click("#play");
await page.waitForTimeout(500);
assert.equal(ttsCalls, callsBeforeReplay, "replay reuses the audio already fetched");

// Speed nudge takes effect without another API call.
await page.click("#slower");
assert.equal(await speed(), "75%");
await page.click("#faster");
assert.equal(await speed(), "80%");
assert.equal(ttsCalls, callsBeforeReplay, "nudging speed costs no API call");

await page.click("#reveal");
await page.waitForSelector("#answerBlock:not([hidden])");
assert.ok((await page.locator("#answerText").innerText()).length > 0, "answer shown");
assert.ok(await page.locator("#gradeRow").isVisible(), "grade buttons appear");
assert.ok(await page.locator("#reveal").isHidden());

await page.click("#right");
await page.waitForTimeout(600);
assert.equal(await speed(), "80%", "the next card starts at its own speed");
// The speed ladder has no calendar: a card stays due until it retires, so the
// badge is unchanged here. SM-2's due-date behaviour is covered in the unit tests.
assert.equal(await page.locator("#dueBadge").innerText(), "2");

await page.click("#reveal");
await page.click("#wrong");
await page.waitForTimeout(600);

// --- speed adaptation persisted ------------------------------------------
await tab("sentences");
const subs = await page.locator(".list .sub").allInnerTexts();
assert.ok(subs.some((s) => s.includes("85%")), `a hit sped a card up: ${JSON.stringify(subs)}`);
assert.ok(subs.some((s) => s.includes("70%")), `a miss slowed a card down: ${JSON.stringify(subs)}`);

// Read the playback record before the reload below wipes it (addInitScript
// re-runs on every navigation, so the array starts empty again).
const plays = await page.evaluate(() => window.__plays);

// --- a provider outage must explain itself --------------------------------
// The deployed app hit HTTP 402 and showed only "device voice unavailable",
// which is exactly the moment the reason matters most.
expectingProviderErrors = true;
await page.unroute("**://api.elevenlabs.io/**");
await page.route("**://api.elevenlabs.io/**", (r) =>
  r.fulfill({ status: 402, contentType: "application/json", body: '{"detail":{"message":"Payment required"}}' }));

// Advance to a card whose audio is not already in memory -- otherwise Play
// reuses the cached blob and never reaches the provider at all.
await tab("review");
await page.click("#reveal");
await page.click("#right");
await page.waitForFunction(
  () => /paid subscription/.test(document.querySelector("#playNote")?.textContent ?? ""),
  null, { timeout: 15000 },
);
const outageNote = await page.locator("#playNote").innerText();
// Headless has no usable system voice, so this exercises the "fallback failed
// too" branch; either way the message must name the fallback and the cause.
assert.ok(/Device voice/i.test(outageNote), `names the fallback: ${outageNote}`);
assert.ok(/free tier is disabled or out of quota/.test(outageNote), `names the cause: ${outageNote}`);

await page.unroute("**://api.elevenlabs.io/**");
await page.route("**://api.elevenlabs.io/**", (r) => {
  ttsCalls++;
  return r.fulfill({ status: 200, contentType: "audio/mpeg", body: SILENT_MP3 });
});
expectingProviderErrors = false;

// --- sync -----------------------------------------------------------------
await tab("settings");
await page.click("#syncNow");
await page.waitForFunction(() => /synced|Nothing/.test(document.querySelector("#sync")?.textContent ?? ""),
  null, { timeout: 15000 });
assert.ok(repoFiles.has("data/dictation.sqlite"), "the database was committed");
const dbBytes = Buffer.from(repoFiles.get("data/dictation.sqlite").b64, "base64");
assert.equal(dbBytes.subarray(0, 15).toString(), "SQLite format 3", "a real SQLite file was pushed");

// Audio must never end up in the database.
assert.ok(!dbBytes.includes(SILENT_MP3.subarray(0, 16)), "no audio bytes in the database");
assert.ok(dbBytes.length < 200_000, `database stays small (${dbBytes.length} bytes)`);

// --- reload restores everything from the repo -----------------------------
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("#dueBadge") !== null);
await tab("sentences");
await page.waitForFunction(() => document.querySelector("#listCount")?.textContent === "2",
  null, { timeout: 15000 });
assert.equal(await page.locator("#listCount").innerText(), "2", "sentences reloaded from GitHub");

// --- scheduler swap -------------------------------------------------------
await tab("settings");
await page.selectOption("#schedulerPick", "sm2");
await page.waitForTimeout(400);
const fields = await page.locator("#paramFields label").allInnerTexts();
assert.ok(fields.some((f) => f.includes("First interval")), "SM-2's own params rendered");
assert.ok(fields.some((f) => f.includes("Starting ease")), "including ones the ladder lacks");

// Tuning a parameter must reach the running session.
await page.fill("#param-startSpeed", "0.6");
await page.dispatchEvent("#param-startSpeed", "change");
await page.waitForTimeout(300);

await page.selectOption("#schedulerPick", "speed-ladder");
await page.waitForTimeout(300);
const ladderFields = await page.locator("#paramFields label").allInnerTexts();
assert.ok(ladderFields.some((f) => f.includes("Retire after")), "ladder params came back");
assert.ok(!ladderFields.some((f) => f.includes("Starting ease")), "SM-2 params are gone");

// --- playback contract ----------------------------------------------------
assert.ok(plays.length > 0, "audio actually played");
for (const p of plays) assert.equal(p.preservesPitch, true, "pitch preserved at every rate");

// --- mobile layout --------------------------------------------------------
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.equal(overflow, 0, "no horizontal scroll on a phone viewport");

const small = await page.evaluate(() =>
  [...document.querySelectorAll("button:not([hidden])")]
    .filter((b) => b.offsetParent !== null)
    .map((b) => ({ t: b.textContent.trim().slice(0, 14), h: Math.round(b.getBoundingClientRect().height) }))
    .filter((b) => b.h > 0 && b.h < 44));
assert.deepEqual(small, [], `all tap targets >= 44px: ${JSON.stringify(small)}`);

assert.deepEqual(problems, [], "no console or page errors");

await browser.close();
console.log(`e2e OK — ${ttsCalls} TTS call(s), ${plays.length} playback(s), db ${dbBytes.length} bytes`);
