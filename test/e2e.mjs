// Browser check for the parts the unit tests can't reach: audio wiring,
// keyboard flow, persistence across reloads.
//
//   npm run serve   # in one terminal
//   npm run e2e     # in another
//
// Set PW_CHROMIUM to use a preinstalled browser instead of Playwright's.

import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8765";
const launch = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};

const browser = await chromium.launch({
  ...launch,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();

const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));

// Record what every Audio element is actually told to do.
await page.addInitScript(() => {
  window.__plays = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__plays.push({ rate: this.playbackRate, preservesPitch: this.preservesPitch });
    return play.call(this);
  };
});

const deck = await (await fetch(`${BASE}/data/deck.json`)).json();
const speed = () => page.locator("#speedLabel").innerText();

await page.goto(BASE, { waitUntil: "networkidle" });
assert.equal(await speed(), "80%", "starts at 80%");

// A miss drops 10 points; overriding re-derives rather than stacking.
await page.fill("#answer", "まったくちがうこたえ");
await page.click("#checkBtn");
await page.waitForSelector("#reveal:not([hidden])");
assert.equal(await speed(), "70%", "miss drops to 70%");

await page.click("#overrideBtn");
assert.equal(await speed(), "85%", "override to correct gives 85%, not 75%");
await page.click("#overrideBtn");
assert.equal(await speed(), "70%", "override back gives 70% again");

// Five straight hits on a single active card retires the deck.
await page.evaluate((ids) => {
  const all = {};
  for (const id of ids.slice(1)) {
    all[id] = { id, speed: 0.8, streak: 5, attempts: 5, hits: 5, retiredAt: 1, lastSeen: 1 };
  }
  all[ids[0]] = { id: ids[0], speed: 0.8, streak: 0, attempts: 0, hits: 0, retiredAt: null, lastSeen: null };
  localStorage.setItem("jpdictation.v1", JSON.stringify(all));
}, deck.sentences.map((s) => s.id));

await page.reload({ waitUntil: "networkidle" });
const target = deck.sentences[0].text;
const ladder = [];
for (let i = 0; i < 5; i++) {
  await page.fill("#answer", target);
  await page.click("#checkBtn");
  await page.waitForSelector("#reveal:not([hidden])");
  assert.equal(await page.locator("#verdict").innerText(), "Word-perfect");
  ladder.push(await speed());
  await page.click("#nextBtn");
  await page.waitForTimeout(100);
}
assert.deepEqual(ladder, ["85%", "90%", "95%", "100%", "105%"], "speed ladder");
assert.ok(await page.locator("#done").isVisible(), "deck is cleared");

await page.reload({ waitUntil: "networkidle" });
assert.ok(await page.locator("#done").isVisible(), "progress survives reload");

// Whatever played, it must have preserved pitch -- that is the whole design.
const plays = await page.evaluate(() => window.__plays);
for (const p of plays) assert.equal(p.preservesPitch, true, "preservesPitch stays on");

assert.deepEqual(problems, [], "no console or page errors");
await browser.close();
console.log(`e2e OK — ${plays.length} playback(s) checked, speed ladder ${ladder.join(" → ")}`);
