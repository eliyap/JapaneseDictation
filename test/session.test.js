import test, { before } from "node:test";
import assert from "node:assert/strict";

import { useNodeSqlJs, fakeGitHub } from "./helpers.js";
import { GitHubSqliteStore } from "../src/adapters/storage/github-sqlite.js";
import { Session } from "../src/core/session.js";
import { defaultParams } from "../src/core/scheduler/index.js";
import { speedLadder } from "../src/core/scheduler/speed-ladder.js";
import { sm2 } from "../src/core/scheduler/sm2.js";

before(useNodeSqlJs);

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

async function freshStore(texts = []) {
  const gh = fakeGitHub();
  const store = new GitHubSqliteStore({
    owner: "o", repo: "r", token: "t", path: "d.sqlite", fetchImpl: gh.fetchImpl,
  });
  await store.load();
  texts.forEach((text, i) =>
    store.upsertSentence({
      id: `s${i + 1}`, text, translation: "", notes: "", tags: [],
      createdAt: T0 + i, archived: false,
    }),
  );
  return { store, gh };
}

function clockedSession(store, over = {}) {
  let t = T0;
  const session = new Session({
    store, now: () => t,
    schedulerId: over.schedulerId ?? speedLadder.id,
    params: over.params ?? {},
  });
  return { session, advance: (ms) => (t += ms), at: () => t };
}

test("new sentences are all due immediately", async () => {
  const { store } = await freshStore(["一", "二", "三"]);
  const { session } = clockedSession(store);
  assert.equal(session.counts().due, 3);
  assert.equal(session.queue().length, 3);
});

test("a review persists card state and appends to the log", async () => {
  const { store } = await freshStore(["一"]);
  const { session } = clockedSession(store);

  session.next();
  const after = session.answer(true);

  assert.equal(after.speed, 0.85);
  assert.equal(store.getCard("s1").streak, 1);

  const log = store.listReviews("s1");
  assert.equal(log.length, 1);
  assert.equal(log[0].correct, true);
  assert.equal(log[0].speed, 0.8, "logs the speed it was heard at, not the new one");
});

test("elapsed time is measured from when the card was shown", async () => {
  const { store } = await freshStore(["一"]);
  const { session, advance } = clockedSession(store);
  session.next();
  advance(4200);
  session.answer(true);
  assert.equal(store.listReviews("s1")[0].elapsedMs, 4200);
});

test("the same card is not served twice in a row", async () => {
  const { store } = await freshStore(["一", "二"]);
  const { session } = clockedSession(store);
  const first = session.next().sentence.id;
  session.answer(true);
  assert.notEqual(session.next().sentence.id, first);
});

test("a single remaining card does repeat", async () => {
  const { store } = await freshStore(["一"]);
  const { session } = clockedSession(store);
  assert.equal(session.next().sentence.id, "s1");
  session.answer(false);
  assert.equal(session.next().sentence.id, "s1");
});

test("retired cards leave the queue", async () => {
  const { store } = await freshStore(["一", "二"]);
  const { session } = clockedSession(store);

  // Five straight hits on s1 retires it under the default ladder.
  for (let i = 0; i < 5; i++) {
    const cur = session.queue().find((c) => c.sentence.id === "s1");
    assert.ok(cur, "s1 should still be queued");
    session.currentId = "s1";
    session.shownAt = T0;
    session.answer(true);
  }
  assert.equal(store.getCard("s1").retired, true);
  assert.deepEqual(session.queue().map((c) => c.sentence.id), ["s2"]);
  assert.equal(session.counts().retired, 1);
});

test("archived sentences are excluded", async () => {
  const { store } = await freshStore(["一", "二"]);
  const s = store.listSentences().find((x) => x.id === "s1");
  store.upsertSentence({ ...s, archived: true });

  const { session } = clockedSession(store);
  assert.deepEqual(session.queue().map((c) => c.sentence.id), ["s2"]);
  assert.equal(session.counts().total, 1);
});

test("with SM-2, a card leaves the queue until its due date", async () => {
  const { store } = await freshStore(["一", "二"]);
  const { session, advance } = clockedSession(store, { schedulerId: sm2.id });

  session.next();
  const id = session.currentId;
  session.answer(true);

  assert.ok(!session.queue().some((c) => c.sentence.id === id), "not due today");
  assert.equal(session.counts().waiting, 1);

  advance(DAY);
  assert.ok(session.queue().some((c) => c.sentence.id === id), "due tomorrow");
});

test("switching scheduler re-reads params and keeps stored card state", async () => {
  const { store } = await freshStore(["一"]);
  const { session } = clockedSession(store);

  session.next();
  session.answer(true);
  const speedBefore = store.getCard("s1").speed;

  session.setScheduler(sm2.id, { firstInterval: 3 });
  assert.equal(session.params.firstInterval, 3);
  assert.equal(session.stateFor("s1").speed, speedBefore, "card state is not reset");

  session.next();
  session.answer(true);
  // The new scheduler takes over from the existing state rather than from scratch.
  assert.equal(store.getCard("s1").reps, 2);
});

test("tunable params actually change behaviour through the session", async () => {
  const { store } = await freshStore(["一"]);
  const { session } = clockedSession(store, { params: { upStep: 0.2, startSpeed: 0.6 } });
  session.next();
  assert.equal(session.current().state.speed, 0.6);
  assert.equal(session.answer(true).speed, 0.8);
});

test("speed can be nudged by hand without recording a review", async () => {
  const { store } = await freshStore(["一"]);
  const { session } = clockedSession(store);
  session.next();

  assert.equal(session.nudgeSpeed(-0.1).speed, 0.7);
  assert.equal(store.listReviews().length, 0, "nudging is not an answer");

  // Clamped to the scheduler's declared range.
  for (let i = 0; i < 20; i++) session.nudgeSpeed(-0.1);
  assert.equal(session.current().state.speed, defaultParams(speedLadder).minSpeed);
});

test("answering with no current card is an error, not a silent no-op", async () => {
  const { store } = await freshStore([]);
  const { session } = clockedSession(store);
  assert.equal(session.next(), null);
  assert.throws(() => session.answer(true), /No card/);
});

test("an empty deck reports zero due", async () => {
  const { store } = await freshStore([]);
  const { session } = clockedSession(store);
  assert.deepEqual(session.counts(), { total: 0, due: 0, retired: 0, waiting: 0 });
});
