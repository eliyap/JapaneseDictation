/** @import { Store, Sentence, CardState, ReviewInput } from '../../core/types.js' */

import { SqliteDb } from "./sqlite-db.js";
import { ContentsApi } from "../github/contents-api.js";

// Store backed by a SQLite file committed to a GitHub repo.
//
// Reads are synchronous against an in-memory database. Writes mutate that
// database AND append to a pending-operation log; `flush` pushes the exported
// bytes back through the Contents API.
//
// The operation log is what makes two devices safe. A SQLite file is an opaque
// binary blob, so git cannot merge it and a naive last-write-wins push would
// silently discard whatever the other device did. Instead, on a sha conflict
// we re-download whatever is now on the remote, replay only our own pending
// operations on top, and push that. Since the data is append-mostly (new
// sentences, new reviews, card state keyed by id) replaying converges rather
// than clobbering.

const DEFAULT_PATH = "data/dictation.sqlite";

export class GitHubSqliteStore {
  #db = null;
  #api = null;
  #sha = null;
  #pending = [];
  #dirty = false;
  #path = DEFAULT_PATH;

  /**
   * @param {{ owner: string, repo: string, branch?: string, token: string,
   *           path?: string, fetchImpl?: typeof fetch, sqlOpts?: object,
   *           onStatus?: (s: {state: string, detail?: string}) => void }} cfg
   */
  constructor(cfg) {
    this.#api = new ContentsApi(cfg);
    this.#path = cfg.path ?? DEFAULT_PATH;
    this.sqlOpts = cfg.sqlOpts ?? {};
    this.onStatus = cfg.onStatus ?? (() => {});
  }

  get path() {
    return this.#path;
  }

  isDirty() {
    return this.#dirty;
  }

  pendingCount() {
    return this.#pending.length;
  }

  // --- lifecycle ----------------------------------------------------------

  async load() {
    this.onStatus({ state: "loading" });
    const found = await this.#api.getFile(this.#path);
    this.#db = await SqliteDb.open(found?.bytes ?? null, this.sqlOpts);
    this.#sha = found?.sha ?? null;
    this.#pending = [];
    this.#dirty = false;
    this.onStatus({ state: found ? "loaded" : "created" });
    return { existed: Boolean(found) };
  }

  /** Push local changes. No-op when nothing has changed. */
  async flush({ message } = {}) {
    if (!this.#dirty || !this.#db) return { pushed: false };
    this.onStatus({ state: "saving" });

    const ops = this.#pending.slice();
    const msg = message ?? `Review session — ${ops.length} change${ops.length === 1 ? "" : "s"}`;

    try {
      const res = await this.#api.putFile(this.#path, this.#db.export(), {
        sha: this.#sha,
        message: msg,
      });
      this.#sha = res.sha;
      this.#pending = [];
      this.#dirty = false;
      this.onStatus({ state: "saved" });
      return { pushed: true, merged: false, commit: res.commit };
    } catch (e) {
      if (!e?.isConflict) {
        this.onStatus({ state: "error", detail: e.message });
        throw e;
      }
      // Someone else pushed since we loaded. Rebase our operations onto theirs.
      this.onStatus({ state: "merging" });
      const res = await this.#rebaseAndPush(ops, msg);
      this.onStatus({ state: "saved", detail: "merged with remote changes" });
      return res;
    }
  }

  async #rebaseAndPush(ops, message) {
    const remote = await this.#api.getFile(this.#path);
    const rebased = await SqliteDb.open(remote?.bytes ?? null, this.sqlOpts);

    for (const op of ops) applyOp(rebased, op);

    const res = await this.#api.putFile(this.#path, rebased.export(), {
      sha: remote?.sha ?? null,
      message: `${message} (merged)`,
    });

    this.#db?.close();
    this.#db = rebased;
    this.#sha = res.sha;
    this.#pending = [];
    this.#dirty = false;
    return { pushed: true, merged: true, commit: res.commit };
  }

  #record(op) {
    applyOp(this.#db, op);
    this.#pending.push(op);
    this.#dirty = true;
  }

  #assertLoaded() {
    if (!this.#db) throw new Error("Store has not been loaded yet");
  }

  // --- Store interface ----------------------------------------------------

  listSentences() {
    this.#assertLoaded();
    return this.#db.listSentences();
  }

  /** @param {Sentence} s */
  upsertSentence(s) {
    this.#assertLoaded();
    this.#record({ kind: "upsertSentence", payload: { ...s } });
  }

  deleteSentence(id) {
    this.#assertLoaded();
    this.#record({ kind: "deleteSentence", payload: id });
  }

  getCard(id) {
    this.#assertLoaded();
    return this.#db.getCard(id);
  }

  /** @param {CardState} state */
  putCard(id, schedulerId, state) {
    this.#assertLoaded();
    this.#record({ kind: "putCard", payload: { id, schedulerId, state } });
  }

  /** @param {ReviewInput} review */
  logReview(sentenceId, review, schedulerId) {
    this.#assertLoaded();
    this.#record({
      kind: "logReview",
      payload: { sentenceId, review, schedulerId, clientId: newId() },
    });
  }

  listReviews(sentenceId = null) {
    this.#assertLoaded();
    return this.#db.listReviews(sentenceId);
  }

  getSetting(key) {
    this.#assertLoaded();
    return this.#db.getSetting(key);
  }

  setSetting(key, value) {
    this.#assertLoaded();
    this.#record({ kind: "setSetting", payload: { key, value } });
  }

  countReviews() {
    this.#assertLoaded();
    return this.#db.countReviews();
  }
}

/**
 * Apply one operation to a database. Shared by the live path and the rebase
 * path, so a merge can never diverge from what a normal write would have done.
 * @param {SqliteDb} db
 */
export function applyOp(db, op) {
  switch (op.kind) {
    case "upsertSentence":
      return db.upsertSentence(op.payload);
    case "deleteSentence":
      return db.deleteSentence(op.payload);
    case "putCard":
      return db.putCard(op.payload.id, op.payload.schedulerId, op.payload.state);
    case "logReview":
      return db.logReview(
        op.payload.sentenceId,
        op.payload.review,
        op.payload.schedulerId,
        op.payload.clientId,
      );
    case "setSetting":
      return db.setSetting(op.payload.key, op.payload.value);
    default:
      throw new Error(`Unknown operation "${op.kind}"`);
  }
}

export function newId() {
  return globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
