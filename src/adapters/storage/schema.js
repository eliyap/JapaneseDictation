// SQLite schema and migrations.
//
// Audio is deliberately absent: nothing here stores a blob. Audio is fetched
// from ElevenLabs at review time and discarded, so the database stays a few
// hundred KB even with thousands of sentences -- which is what keeps the
// GitHub Contents API a viable sync channel.

export const SCHEMA_VERSION = 1;

/** Applied in order; each entry's index+1 is the user_version it produces. */
export const MIGRATIONS = [
  // v1 -- initial
  `
  CREATE TABLE IF NOT EXISTS sentences (
    id          TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    translation TEXT,
    notes       TEXT,
    tags        TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cards (
    sentence_id TEXT PRIMARY KEY,
    scheduler   TEXT    NOT NULL,
    due         INTEGER,
    speed       REAL    NOT NULL,
    reps        INTEGER NOT NULL DEFAULT 0,
    lapses      INTEGER NOT NULL DEFAULT 0,
    streak      INTEGER NOT NULL DEFAULT 0,
    retired     INTEGER NOT NULL DEFAULT 0,
    algo        TEXT    NOT NULL DEFAULT '{}',
    updated_at  INTEGER NOT NULL
  );

  -- Append-only. This is the training data an FSRS-style scheduler needs, so
  -- it is captured from the first review even though nothing reads it yet.
  CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Client-generated, unique. Makes replaying an unacknowledged write
    -- idempotent: if a push landed but the response was lost, the retry
    -- re-inserts the same rows and the index drops them.
    client_id   TEXT    NOT NULL UNIQUE,
    sentence_id TEXT    NOT NULL,
    reviewed_at INTEGER NOT NULL,
    correct     INTEGER NOT NULL,
    speed       REAL    NOT NULL,
    scheduler   TEXT    NOT NULL,
    elapsed_ms  INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cards_due       ON cards(due);
  CREATE INDEX IF NOT EXISTS idx_reviews_by_card ON reviews(sentence_id, reviewed_at);
  `,
];

/**
 * Bring a database up to the current schema version.
 * @param {import('sql.js').Database} db
 */
export function migrate(db) {
  const current = db.exec("PRAGMA user_version")[0]?.values?.[0]?.[0] ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]);
  }
  if (current < MIGRATIONS.length) {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }
  return MIGRATIONS.length;
}
