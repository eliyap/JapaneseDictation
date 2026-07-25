/** @import { Sentence, CardState, ReviewInput, ReviewLogEntry } from '../../core/types.js' */

import { migrate } from "./schema.js";

// Synchronous query layer over a sql.js database. No network, no sync, no
// knowledge of where the bytes came from -- that is the sync layer's job.
// Runs unchanged in Node, which is why the store is testable without a browser.

let sqlJsPromise = null;

/**
 * Load the sql.js runtime once per page.
 * @param {{ locateFile?: (f: string) => string }} [opts]
 */
export function loadSqlJs(opts = {}) {
  if (!sqlJsPromise) {
    const init = globalThis.initSqlJs;
    if (typeof init !== "function") {
      return Promise.reject(new Error("sql.js is not loaded (expected globalThis.initSqlJs)"));
    }
    sqlJsPromise = init(opts);
  }
  return sqlJsPromise;
}

/** Reset between tests. */
export function _resetSqlJs() {
  sqlJsPromise = null;
}

export class SqliteDb {
  /** @param {any} SQL @param {Uint8Array|null} bytes */
  constructor(SQL, bytes = null) {
    this.db = bytes && bytes.length > 0 ? new SQL.Database(bytes) : new SQL.Database();
    this.db.exec("PRAGMA foreign_keys = ON");
    migrate(this.db);
  }

  static async open(bytes = null, opts = {}) {
    const SQL = await loadSqlJs(opts);
    return new SqliteDb(SQL, bytes);
  }

  export() {
    return this.db.export();
  }

  close() {
    this.db.close();
  }

  #all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  #one(sql, params = []) {
    return this.#all(sql, params)[0] ?? null;
  }

  // --- sentences ----------------------------------------------------------

  /** @returns {Sentence[]} */
  listSentences() {
    return this.#all("SELECT * FROM sentences ORDER BY created_at DESC").map(rowToSentence);
  }

  /** @returns {Sentence|null} */
  getSentence(id) {
    const r = this.#one("SELECT * FROM sentences WHERE id = ?", [id]);
    return r ? rowToSentence(r) : null;
  }

  /** @param {Sentence} s */
  upsertSentence(s) {
    this.db.run(
      `INSERT INTO sentences (id, text, translation, notes, tags, created_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text, translation = excluded.translation,
         notes = excluded.notes, tags = excluded.tags, archived = excluded.archived`,
      [
        s.id,
        s.text,
        s.translation ?? null,
        s.notes ?? null,
        (s.tags ?? []).join(","),
        s.createdAt ?? Date.now(),
        s.archived ? 1 : 0,
      ],
    );
  }

  deleteSentence(id) {
    this.db.run("DELETE FROM cards WHERE sentence_id = ?", [id]);
    this.db.run("DELETE FROM sentences WHERE id = ?", [id]);
    // Review history is kept on purpose: it is the training data, and it stays
    // meaningful even once the sentence itself is gone.
  }

  // --- cards --------------------------------------------------------------

  /** @returns {CardState|null} */
  getCard(sentenceId) {
    const r = this.#one("SELECT * FROM cards WHERE sentence_id = ?", [sentenceId]);
    if (!r) return null;
    return {
      due: r.due === null ? null : Number(r.due),
      speed: Number(r.speed),
      reps: Number(r.reps),
      lapses: Number(r.lapses),
      streak: Number(r.streak),
      retired: Boolean(r.retired),
      algo: safeJson(r.algo, {}),
    };
  }

  /** @param {CardState} state */
  putCard(sentenceId, schedulerId, state) {
    this.db.run(
      `INSERT INTO cards (sentence_id, scheduler, due, speed, reps, lapses, streak, retired, algo, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sentence_id) DO UPDATE SET
         scheduler = excluded.scheduler, due = excluded.due, speed = excluded.speed,
         reps = excluded.reps, lapses = excluded.lapses, streak = excluded.streak,
         retired = excluded.retired, algo = excluded.algo, updated_at = excluded.updated_at`,
      [
        sentenceId,
        schedulerId,
        state.due ?? null,
        state.speed,
        state.reps,
        state.lapses,
        state.streak,
        state.retired ? 1 : 0,
        JSON.stringify(state.algo ?? {}),
        Date.now(),
      ],
    );
  }

  // --- reviews ------------------------------------------------------------

  /** @param {ReviewInput} review */
  logReview(sentenceId, review, schedulerId, clientId) {
    this.db.run(
      `INSERT OR IGNORE INTO reviews
         (client_id, sentence_id, reviewed_at, correct, speed, scheduler, elapsed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId,
        sentenceId,
        review.at,
        review.correct ? 1 : 0,
        review.speed,
        schedulerId,
        review.elapsedMs ?? null,
      ],
    );
  }

  /** @returns {ReviewLogEntry[]} */
  listReviews(sentenceId = null) {
    const rows = sentenceId
      ? this.#all("SELECT * FROM reviews WHERE sentence_id = ? ORDER BY reviewed_at", [sentenceId])
      : this.#all("SELECT * FROM reviews ORDER BY reviewed_at");
    return rows.map((r) => ({
      sentenceId: r.sentence_id,
      reviewedAt: Number(r.reviewed_at),
      correct: Boolean(r.correct),
      speed: Number(r.speed),
      scheduler: r.scheduler,
      elapsedMs: r.elapsed_ms === null ? null : Number(r.elapsed_ms),
    }));
  }

  countReviews() {
    return Number(this.#one("SELECT COUNT(*) AS n FROM reviews")?.n ?? 0);
  }

  // --- settings -----------------------------------------------------------

  getSetting(key) {
    return this.#one("SELECT value FROM settings WHERE key = ?", [key])?.value ?? null;
  }

  setSetting(key, value) {
    this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, String(value)],
    );
  }
}

/** @returns {Sentence} */
function rowToSentence(r) {
  return {
    id: r.id,
    text: r.text,
    translation: r.translation ?? "",
    notes: r.notes ?? "",
    tags: r.tags ? String(r.tags).split(",").filter(Boolean) : [],
    createdAt: Number(r.created_at),
    archived: Boolean(r.archived),
  };
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
