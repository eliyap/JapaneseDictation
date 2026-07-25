import test, { before } from "node:test";
import assert from "node:assert/strict";

import { useNodeSqlJs, openDb, fakeGitHub, remoteWrite } from "./helpers.js";
import { GitHubSqliteStore } from "../src/adapters/storage/github-sqlite.js";
import { ContentsApi, encodeBase64, decodeBase64 } from "../src/adapters/github/contents-api.js";
import { SCHEMA_VERSION } from "../src/adapters/storage/schema.js";

before(useNodeSqlJs);

const PATH = "data/dictation.sqlite";
const T0 = 1_700_000_000_000;

const sentence = (id, text) => ({
  id, text, translation: "", notes: "", tags: [], createdAt: T0, archived: false,
});
const cardState = (over = {}) => ({
  due: null, speed: 0.8, reps: 0, lapses: 0, streak: 0, retired: false, algo: {}, ...over,
});
const review = (over = {}) => ({ correct: true, at: T0, speed: 0.8, elapsedMs: 1234, ...over });

const makeStore = (gh) =>
  new GitHubSqliteStore({
    owner: "eliyap", repo: "JapaneseDictation", branch: "main",
    token: "test-token", path: PATH, fetchImpl: gh.fetchImpl,
  });

// --- base64 ---------------------------------------------------------------

test("base64 round-trips binary, including bytes above 0x7f", () => {
  const bytes = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
  assert.deepEqual(decodeBase64(encodeBase64(bytes)), bytes);
});

test("base64 decoding tolerates the newlines GitHub inserts", () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
  const wrapped = encodeBase64(bytes).replace(/(.{4})/g, "$1\n");
  assert.deepEqual(decodeBase64(wrapped), bytes);
});

// --- sqlite layer ---------------------------------------------------------

test("a fresh database is migrated to the current schema", async () => {
  const db = await openDb();
  const v = db.db.exec("PRAGMA user_version")[0].values[0][0];
  assert.equal(v, SCHEMA_VERSION);
  db.close();
});

test("sentences and cards round-trip through export/import", async () => {
  const db = await openDb();
  db.upsertSentence({ ...sentence("s1", "犬が好きです。"), tags: ["animals", "n5"] });
  db.putCard("s1", "sm2", cardState({ due: T0, streak: 3, algo: { ease: 2.3 } }));
  const bytes = db.export();
  db.close();

  const reopened = await openDb(bytes);
  const [s] = reopened.listSentences();
  assert.equal(s.text, "犬が好きです。");
  assert.deepEqual(s.tags, ["animals", "n5"]);

  const c = reopened.getCard("s1");
  assert.equal(c.streak, 3);
  assert.equal(c.algo.ease, 2.3, "algorithm-private state survives");
  reopened.close();
});

test("upserting a sentence twice updates rather than duplicating", async () => {
  const db = await openDb();
  db.upsertSentence(sentence("s1", "first"));
  db.upsertSentence({ ...sentence("s1", "second"), translation: "t" });
  assert.equal(db.listSentences().length, 1);
  assert.equal(db.listSentences()[0].text, "second");
  db.close();
});

test("deleting a sentence removes its card but keeps its review history", async () => {
  const db = await openDb();
  db.upsertSentence(sentence("s1", "x"));
  db.putCard("s1", "sm2", cardState());
  db.logReview("s1", review(), "sm2", "c1");
  db.deleteSentence("s1");

  assert.equal(db.listSentences().length, 0);
  assert.equal(db.getCard("s1"), null);
  assert.equal(db.listReviews("s1").length, 1, "history is training data; keep it");
  db.close();
});

test("reviews are idempotent on client id", async () => {
  const db = await openDb();
  db.upsertSentence(sentence("s1", "x"));
  db.logReview("s1", review(), "sm2", "same-id");
  db.logReview("s1", review(), "sm2", "same-id");
  assert.equal(db.countReviews(), 1, "a replayed write must not duplicate");
  db.close();
});

// --- contents api ---------------------------------------------------------

test("a missing file reads as null, not an error", async () => {
  const gh = fakeGitHub();
  const api = new ContentsApi({ owner: "o", repo: "r", token: "t", fetchImpl: gh.fetchImpl });
  assert.equal(await api.getFile(PATH), null);
});

test("put then get round-trips bytes and returns a new sha", async () => {
  const gh = fakeGitHub();
  const api = new ContentsApi({ owner: "o", repo: "r", token: "t", fetchImpl: gh.fetchImpl });

  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const put = await api.putFile(PATH, bytes, { message: "m" });
  assert.ok(put.sha);

  const got = await api.getFile(PATH);
  assert.deepEqual(got.bytes, bytes);
  assert.equal(got.sha, put.sha);
});

test("a stale sha surfaces as a conflict", async () => {
  const gh = fakeGitHub();
  const api = new ContentsApi({ owner: "o", repo: "r", token: "t", fetchImpl: gh.fetchImpl });
  await api.putFile(PATH, new Uint8Array([1]), { message: "m" });

  await assert.rejects(
    () => api.putFile(PATH, new Uint8Array([2]), { sha: "stale", message: "m" }),
    (e) => e.isConflict === true && e.status === 409,
  );
});

// --- store ----------------------------------------------------------------

test("first load creates the database; flush commits it", async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);

  const { existed } = await store.load();
  assert.equal(existed, false);
  assert.equal(store.isDirty(), false);

  store.upsertSentence(sentence("s1", "こんにちは。"));
  assert.equal(store.isDirty(), true);

  const res = await store.flush();
  assert.equal(res.pushed, true);
  assert.equal(store.isDirty(), false);
  assert.ok(gh.files.has(PATH), "the file landed in the repo");
});

test("flushing with no changes does nothing", async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  await store.load();
  const before = gh.calls.length;
  assert.deepEqual(await store.flush(), { pushed: false });
  assert.equal(gh.calls.length, before, "no request is made");
});

test("a second device sees what the first one wrote", async () => {
  const gh = fakeGitHub();
  const a = makeStore(gh);
  await a.load();
  a.upsertSentence(sentence("s1", "一"));
  await a.flush();

  const b = makeStore(gh);
  const { existed } = await b.load();
  assert.equal(existed, true);
  assert.equal(b.listSentences()[0].text, "一");
});

test("a concurrent remote change is merged, not clobbered", async () => {
  const gh = fakeGitHub();

  // Device A loads and starts working.
  const a = makeStore(gh);
  await a.load();
  a.upsertSentence(sentence("a1", "Aの文"));
  await a.flush();

  const b = makeStore(gh);
  await b.load();

  // Both devices now make changes without seeing each other's.
  b.upsertSentence(sentence("b1", "Bの文"));
  b.logReview("a1", review({ at: T0 + 1 }), "sm2");

  await remoteWrite(gh, PATH, (db) => {
    db.upsertSentence(sentence("a2", "Aの新しい文"));
    db.logReview("a1", { ...review({ at: T0 + 2 }), correct: false }, "sm2", "remote-review");
  });

  const res = await b.flush();
  assert.equal(res.merged, true, "the conflict was rebased, not force-pushed");

  // Everything from both sides survives.
  const final = makeStore(gh);
  await final.load();
  const ids = final.listSentences().map((s) => s.id).sort();
  assert.deepEqual(ids, ["a1", "a2", "b1"]);
  assert.equal(final.listReviews().length, 2, "both review logs are present");
});

test("a merge leaves the store clean and usable", async () => {
  const gh = fakeGitHub();
  const a = makeStore(gh);
  await a.load();
  a.upsertSentence(sentence("s1", "x"));
  await a.flush();

  const b = makeStore(gh);
  await b.load();
  b.upsertSentence(sentence("s2", "y"));
  await remoteWrite(gh, PATH, (db) => db.upsertSentence(sentence("s3", "z")));
  await b.flush();

  assert.equal(b.isDirty(), false);
  assert.equal(b.pendingCount(), 0);
  // The in-memory database was swapped for the merged one, so reads are fresh.
  assert.deepEqual(b.listSentences().map((s) => s.id).sort(), ["s1", "s2", "s3"]);
});

test("card state written before a merge survives it", async () => {
  const gh = fakeGitHub();
  const a = makeStore(gh);
  await a.load();
  a.upsertSentence(sentence("s1", "x"));
  await a.flush();

  const b = makeStore(gh);
  await b.load();
  b.putCard("s1", "sm2", cardState({ streak: 4, speed: 1.0, algo: { ease: 2.9 } }));
  await remoteWrite(gh, PATH, (db) => db.upsertSentence(sentence("other", "y")));
  await b.flush();

  const final = makeStore(gh);
  await final.load();
  const c = final.getCard("s1");
  assert.equal(c.streak, 4);
  assert.equal(c.algo.ease, 2.9);
});

test("reads before load fail loudly", async () => {
  const store = makeStore(fakeGitHub());
  assert.throws(() => store.listSentences(), /not been loaded/);
});

test("settings round-trip", async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  await store.load();
  store.setSetting("scheduler", "sm2");
  await store.flush();

  const other = makeStore(gh);
  await other.load();
  assert.equal(other.getSetting("scheduler"), "sm2");
  assert.equal(other.getSetting("nope"), null);
});
