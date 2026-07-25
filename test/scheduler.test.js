import test from "node:test";
import assert from "node:assert/strict";

import { speedLadder } from "../src/core/scheduler/speed-ladder.js";
import { sm2 } from "../src/core/scheduler/sm2.js";
import {
  listSchedulers, getScheduler, defaultParams, resolveParams, register,
} from "../src/core/scheduler/index.js";

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

const params = (s, over = {}) => ({ ...defaultParams(s), ...over });
const hit = (s, st, p, at = T0) => s.review(st, { correct: true, at, speed: st.speed }, p);
const miss = (s, st, p, at = T0) => s.review(st, { correct: false, at, speed: st.speed }, p);

// --- the contract every scheduler must honour -----------------------------

for (const s of listSchedulers()) {
  test(`[${s.id}] satisfies the Scheduler contract`, () => {
    const p = params(s);
    const init = s.init(p);

    for (const k of ["due", "speed", "reps", "lapses", "streak", "retired", "algo"]) {
      assert.ok(k in init, `init() must produce "${k}"`);
    }
    assert.equal(init.reps, 0);
    assert.equal(init.retired, false);

    const after = hit(s, init, p);
    assert.equal(after.reps, 1, "review() increments reps");
    assert.equal(init.reps, 0, "review() must not mutate its input");
    assert.equal(typeof s.isDue(after, T0), "boolean");
    assert.equal(typeof s.priority(after, T0), "number");
  });

  test(`[${s.id}] is deterministic and pure`, () => {
    const p = params(s);
    const st = s.init(p);
    const a = JSON.stringify(hit(s, st, p));
    const b = JSON.stringify(hit(s, st, p));
    assert.equal(a, b, "same inputs must give the same output");
  });

  test(`[${s.id}] keeps speed inside its declared range`, () => {
    const p = params(s);
    let st = s.init(p);
    for (let i = 0; i < 50; i++) st = hit(s, st, p, T0 + i * DAY);
    assert.ok(st.speed <= p.maxSpeed + 1e-9, `${st.speed} <= ${p.maxSpeed}`);
    for (let i = 0; i < 50; i++) st = miss(s, st, p, T0 + i * DAY);
    assert.ok(st.speed >= p.minSpeed - 1e-9, `${st.speed} >= ${p.minSpeed}`);
  });
}

// --- speed ladder ---------------------------------------------------------

test("speed ladder: +5 on a hit, -10 on a miss, from 80%", () => {
  const p = params(speedLadder);
  const st = speedLadder.init(p);
  assert.equal(st.speed, 0.8);
  assert.equal(hit(speedLadder, st, p).speed, 0.85);
  assert.equal(miss(speedLadder, st, p).speed, 0.7);
});

test("speed ladder: retires on a run of five, and a miss undoes it", () => {
  const p = params(speedLadder);
  let st = speedLadder.init(p);
  for (let i = 0; i < 4; i++) st = hit(speedLadder, st, p);
  assert.equal(st.retired, false, "four is not enough");
  st = hit(speedLadder, st, p);
  assert.equal(st.retired, true);
  st = miss(speedLadder, st, p);
  assert.equal(st.retired, false);
  assert.equal(st.streak, 0);
});

test("speed ladder: retireAtMaxOnly requires the run to happen at top speed", () => {
  const p = params(speedLadder, { retireAtMaxOnly: true });
  let st = speedLadder.init(p);
  for (let i = 0; i < 5; i++) st = hit(speedLadder, st, p);
  assert.equal(st.retired, false, "a run starting at 80% must not retire");

  // Climb to the ceiling, then take five more at that speed.
  for (let i = 0; i < 10; i++) st = hit(speedLadder, st, p);
  assert.equal(st.speed, p.maxSpeed);
  assert.equal(st.retired, true);
});

test("speed ladder: tuning the steps changes the ladder", () => {
  const p = params(speedLadder, { upStep: 0.2, downStep: 0.3, startSpeed: 0.9 });
  const st = speedLadder.init(p);
  assert.equal(st.speed, 0.9);
  assert.equal(hit(speedLadder, st, p).speed, 1.1);
  assert.equal(miss(speedLadder, st, p).speed, 0.6);
});

test("speed ladder: retired cards are not due, others always are", () => {
  const p = params(speedLadder);
  const st = speedLadder.init(p);
  assert.equal(speedLadder.isDue(st, T0), true);
  assert.equal(speedLadder.isDue({ ...st, retired: true }, T0), false);
});

// --- sm2 ------------------------------------------------------------------

test("sm2: intervals grow 1 day, 6 days, then by ease", () => {
  const p = params(sm2);
  let st = sm2.init(p);

  st = hit(sm2, st, p, T0);
  assert.equal(st.due, T0 + 1 * DAY);

  st = hit(sm2, st, p, st.due);
  assert.equal(st.due, st.algo.intervalDays * DAY + (T0 + 1 * DAY));
  assert.equal(st.algo.intervalDays, 6);

  const before = st.due;
  st = hit(sm2, st, p, before);
  assert.ok(st.algo.intervalDays > 6, "third interval multiplies by ease");
});

test("sm2: a lapse resets the interval and raises the lapse count", () => {
  const p = params(sm2);
  let st = sm2.init(p);
  st = hit(sm2, st, p, T0);
  st = hit(sm2, st, p, T0 + DAY);
  assert.equal(st.lapses, 0);

  st = miss(sm2, st, p, T0 + 7 * DAY);
  assert.equal(st.lapses, 1);
  assert.equal(st.streak, 0);
  assert.equal(st.algo.intervalDays, 0, "back in this session by default");
});

test("sm2: ease falls on failure but never below the floor", () => {
  const p = params(sm2);
  let st = sm2.init(p);
  assert.equal(st.algo.ease, 2.5);
  for (let i = 0; i < 30; i++) st = miss(sm2, st, p, T0 + i * DAY);
  assert.ok(st.algo.ease >= p.minEase - 1e-9, `${st.algo.ease} >= ${p.minEase}`);
});

test("sm2: a card is not due before its due date", () => {
  const p = params(sm2);
  const st = hit(sm2, sm2.init(p), p, T0);
  assert.equal(sm2.isDue(st, T0 + DAY / 2), false);
  assert.equal(sm2.isDue(st, T0 + DAY), true);
});

test("sm2: retires once the interval passes the threshold", () => {
  const p = params(sm2, { retireIntervalDays: 30 });
  let st = sm2.init(p);
  for (let i = 0; i < 10 && !st.retired; i++) st = hit(sm2, st, p, st.due ?? T0);
  assert.equal(st.retired, true);
  assert.ok(st.algo.intervalDays >= 30);
});

test("sm2: retirement can be switched off entirely", () => {
  const p = params(sm2, { retireIntervalDays: 0 });
  let st = sm2.init(p);
  for (let i = 0; i < 15; i++) st = hit(sm2, st, p, st.due ?? T0);
  assert.equal(st.retired, false);
});

// --- registry -------------------------------------------------------------

test("registry: unknown ids fall back rather than throwing", () => {
  // A database synced from a device running a newer build must not brick this one.
  assert.equal(getScheduler("does-not-exist").id, speedLadder.id);
  assert.equal(getScheduler(sm2.id).id, sm2.id);
});

test("registry: rejects an incomplete scheduler", () => {
  assert.throws(() => register({ id: "broken", label: "x", params: [] }), /missing "init"/);
});

test("params: stored values are clamped and coerced", () => {
  const p = resolveParams(speedLadder, {
    startSpeed: "0.95",       // string from a form
    maxSpeed: 99,             // beyond the declared max
    retireStreak: "not a number",
    retireAtMaxOnly: "true",
  });
  assert.equal(p.startSpeed, 0.95);
  assert.equal(p.maxSpeed, 2.0);
  assert.equal(p.retireStreak, 5, "garbage falls back to the default");
  assert.equal(p.retireAtMaxOnly, true);
});

test("params: missing keys fall back to declared defaults", () => {
  assert.deepEqual(resolveParams(speedLadder, {}), defaultParams(speedLadder));
  assert.deepEqual(resolveParams(speedLadder, undefined), defaultParams(speedLadder));
});
