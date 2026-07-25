import test from "node:test";
import assert from "node:assert/strict";

import { newCard, grade, pickNext, isRetired, SPEED, RETIRE_STREAK } from "../js/srs.js";
import { normalize, isExact, isNearMiss, diffChars } from "../js/grade.js";

const hit = (c) => grade(c, true);
const miss = (c) => grade(c, false);

test("starts at 80%", () => {
  assert.equal(newCard("a").speed, 0.8);
  assert.equal(SPEED.start, 0.8);
});

test("a hit speeds up 5 points, a miss slows down 10", () => {
  assert.equal(hit(newCard("a")).speed, 0.85);
  assert.equal(miss(newCard("a")).speed, 0.7);
});

test("speed stays inside 50-110% and never drifts off the 0.05 grid", () => {
  let c = newCard("a");
  for (let i = 0; i < 40; i++) c = hit(c);
  assert.equal(c.speed, SPEED.max);

  for (let i = 0; i < 40; i++) c = miss(c);
  assert.equal(c.speed, SPEED.min);

  // Interleaving must land on clean 2dp values, not 0.7500000000000001.
  c = newCard("a");
  for (let i = 0; i < 25; i++) c = i % 3 === 0 ? miss(c) : hit(c);
  assert.equal(c.speed, Math.round(c.speed * 100) / 100);
});

test("retires after five straight hits, and not before", () => {
  let c = newCard("a");
  for (let i = 0; i < RETIRE_STREAK - 1; i++) c = hit(c);
  assert.equal(isRetired(c), false, "four in a row is not enough");
  c = hit(c);
  assert.equal(isRetired(c), true);
});

test("a miss breaks the streak and un-retires", () => {
  let c = newCard("a");
  for (let i = 0; i < RETIRE_STREAK; i++) c = hit(c);
  assert.equal(isRetired(c), true);

  c = miss(c);
  assert.equal(isRetired(c), false);
  assert.equal(c.streak, 0);
});

test("five straight hits at the ceiling still retire", () => {
  // Walk to 110% with misses interleaved so the streak resets, then run five.
  let c = newCard("a");
  for (let i = 0; i < 20; i++) c = hit(c);
  c = { ...c, streak: 0, retiredAt: null };
  assert.equal(c.speed, SPEED.max);
  for (let i = 0; i < RETIRE_STREAK; i++) c = hit(c);
  assert.equal(isRetired(c), true);
});

test("grade does not mutate its input", () => {
  const c = newCard("a");
  const frozen = JSON.stringify(c);
  hit(c);
  miss(c);
  assert.equal(JSON.stringify(c), frozen);
});

test("pickNext skips retired cards and returns null when all are done", () => {
  const a = { ...newCard("a"), retiredAt: 1, lastSeen: 1 };
  const b = { ...newCard("b"), lastSeen: 5 };
  assert.equal(pickNext([a, b])?.id, "b");
  assert.equal(pickNext([a, { ...b, retiredAt: 2 }]), null);
});

test("pickNext avoids repeating the card just answered", () => {
  const cards = [
    { ...newCard("a"), lastSeen: 100 },
    { ...newCard("b"), lastSeen: 200 },
  ];
  assert.equal(pickNext(cards, { exclude: "a" }).id, "b");
});

test("pickNext repeats the last card when it is the only one left", () => {
  const only = [{ ...newCard("a"), lastSeen: 1 }];
  assert.equal(pickNext(only, { exclude: "a" }).id, "a");
});

test("pickNext prefers the least recently seen", () => {
  const cards = [
    { ...newCard("a"), lastSeen: 300 },
    { ...newCard("b"), lastSeen: 100 },
    { ...newCard("c"), lastSeen: 200 },
  ];
  assert.equal(pickNext(cards).id, "b");
});

// --- grading -------------------------------------------------------------

test("punctuation and spacing are ignored", () => {
  const t = "明日の朝、駅で友だちに会う約束をしました。";
  assert.ok(isExact("明日の朝 駅で友だちに会う約束をしました", t));
  assert.ok(isExact(t, t));
});

test("full-width and half-width kana fold together", () => {
  assert.equal(normalize("ｱｲｳ"), normalize("アイウ"));
  assert.ok(isExact("ｶﾞｯｺｳ", "がっこう".replace(/./g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0x60))), "katakana school");
});

test("wrong kanji is a miss", () => {
  assert.equal(isExact("先生に送弾してから", "先生に相談してから"), false);
});

test("an empty answer is never correct", () => {
  assert.equal(isExact("", "何か"), false);
  assert.equal(isExact("", ""), false);
});

test("long-vowel marks are significant but flagged as a near miss", () => {
  assert.equal(isExact("スパー", "スーパー"), false);
  assert.equal(isNearMiss("スパー", "スーパー"), true);
  assert.equal(isNearMiss("スーパー", "スーパー"), false, "exact is not a near miss");
});

test("diff reconstructs both sides", () => {
  const answer = "駅で友だちに会いました";
  const target = "駅で友だちに会う約束をしました";
  const parts = diffChars(answer, target);

  const back = (types) => parts.filter((p) => types.includes(p.type)).map((p) => p.text).join("");
  assert.equal(back(["same", "add"]), answer, "same+add rebuilds what was typed");
  assert.equal(back(["same", "del"]), target, "same+del rebuilds the target");
});

test("diff of identical strings is one 'same' run", () => {
  assert.deepEqual(diffChars("犬", "犬"), [{ type: "same", text: "犬" }]);
});
