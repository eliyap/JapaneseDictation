/** @import { Store, Sentence, CardState, ReviewInput } from '../../core/types.js' */

import { SqliteDb } from "./sqlite-db.js";
import { ContentsApi } from "../github/contents-api.js";

// Store backed by a SQLite file committed to a GitHub repo.
//
// Reads are synchronous against an in-memory database; only `load` and `flush`
// touch the network. `flush` sends the whole file with the blob sha it last
// saw, so GitHub rejects the write if anything else changed it in the meantime.
//
// There is no merge or replay machinery here on purpose. A SQLite file is an
// opaque blob that git cannot merge, and this is a single-person app where two
// devices writing between syncs is rare. A conflict is therefore reported
// rather than resolved: local changes stay in memory and dirty, so you can
// retry or reload and decide for yourself.

const DEFAULT_PATH = "data/dictation.sqlite";

export class ConflictError extends Error {
  constructor() {
    super(
      "This database was changed somewhere else since it loaded. " +
      "Reload to pick up those changes — anything answered since the last sync will be lost.",
    );
    this.name = "ConflictError";
  }
}

export class GitHubSqliteStore {
  #db = null;
  #api = null;
  #sha = null;
  #dirty = false;
  #path = DEFAULT_PATH;
  #queue = Promise.resolve();

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

  // --- lifecycle ----------------------------------------------------------

  async load() {
    this.onStatus({ state: "loading" });
    const found = await this.#api.getFile(this.#path);
    this.#db?.close();
    this.#db = await SqliteDb.open(found?.bytes ?? null, this.sqlOpts);
    this.#sha = found?.sha ?? null;
    this.#dirty = false;
    this.onStatus({ state: found ? "loaded" : "created" });
    return { existed: Boolean(found) };
  }

  /**
   * Push local changes. No-op when nothing has changed.
   *
   * Serialized: `#sha` is only updated once a PUT resolves, so two overlapping
   * flushes would both send the sha they read beforehand and the second would
   * be rejected as a conflict against the first. That is easy to trigger --
   * backgrounding a phone fires `visibilitychange` and `pagehide` together,
   * and both flush. Queueing makes the second call see the updated sha, or
   * find nothing left to do.
   */
  flush(opts = {}) {
    const run = () => this.#flushOnce(opts);
    const next = this.#queue.then(run, run);
    // Keep the queue usable after a rejection; callers still see this one throw.
    this.#queue = next.then(noop, noop);
    return next;
  }

  async #flushOnce({ message } = {}) {
    if (!this.#dirty || !this.#db) return { pushed: false };
    this.onStatus({ state: "saving" });

    try {
      const res = await this.#api.putFile(this.#path, this.#db.export(), {
        sha: this.#sha,
        message: message ?? "Update dictation progress",
      });
      this.#sha = res.sha;
      this.#dirty = false;
      this.onStatus({ state: "saved" });
      return { pushed: true, commit: res.commit };
    } catch (e) {
      // Stay dirty either way: nothing was written, so the local changes are
      // still the only copy.
      if (e?.isConflict) {
        this.onStatus({ state: "conflict" });
        throw new ConflictError();
      }
      this.onStatus({ state: "error", detail: e.message });
      throw e;
    }
  }

  #touch() {
    if (!this.#db) throw new Error("Store has not been loaded yet");
    this.#dirty = true;
  }

  #read() {
    if (!this.#db) throw new Error("Store has not been loaded yet");
    return this.#db;
  }

  // --- Store interface ----------------------------------------------------

  listSentences() {
    return this.#read().listSentences();
  }

  /** @param {Sentence} s */
  upsertSentence(s) {
    this.#touch();
    this.#db.upsertSentence(s);
  }

  deleteSentence(id) {
    this.#touch();
    this.#db.deleteSentence(id);
  }

  getCard(id) {
    return this.#read().getCard(id);
  }

  /** @param {CardState} state */
  putCard(id, schedulerId, state) {
    this.#touch();
    this.#db.putCard(id, schedulerId, state);
  }

  /** @param {ReviewInput} review */
  logReview(sentenceId, review, schedulerId) {
    this.#touch();
    this.#db.logReview(sentenceId, review, schedulerId);
  }

  listReviews(sentenceId = null) {
    return this.#read().listReviews(sentenceId);
  }

  getSetting(key) {
    return this.#read().getSetting(key);
  }

  setSetting(key, value) {
    this.#touch();
    this.#db.setSetting(key, value);
  }

  countReviews() {
    return this.#read().countReviews();
  }
}

function noop() {}

export function newId() {
  return globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
