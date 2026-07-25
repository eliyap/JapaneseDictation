// Scheduling + speed adaptation. Pure functions, no DOM, no storage.

export const SPEED = {
  min: 0.5,
  max: 1.1,
  start: 0.8,
  onHit: +0.05,
  onMiss: -0.10,
};

export const RETIRE_STREAK = 5;

/** Round to 2dp so repeated +0.05/-0.10 never drifts into 0.7500000000000001. */
const q = (n) => Math.round(n * 100) / 100;

const clamp = (n) => Math.min(SPEED.max, Math.max(SPEED.min, q(n)));

export function newCard(id) {
  return {
    id,
    speed: SPEED.start,
    streak: 0,
    attempts: 0,
    hits: 0,
    retiredAt: null,
    lastSeen: null,
  };
}

/**
 * Apply one graded attempt. Returns a new card; never mutates the input.
 *
 * Speed is clamped to the range, so a hit at 1.10 keeps you at 1.10 and still
 * counts toward the streak -- that's what makes "5 straight hits in the range"
 * reachable from the top of the range as well as from the middle.
 */
export function grade(card, correct, now = Date.now()) {
  const next = { ...card };
  next.attempts += 1;
  next.lastSeen = now;

  if (correct) {
    next.hits += 1;
    next.streak += 1;
    next.speed = clamp(card.speed + SPEED.onHit);
    if (next.streak >= RETIRE_STREAK && next.retiredAt === null) {
      next.retiredAt = now;
    }
  } else {
    next.streak = 0;
    next.speed = clamp(card.speed + SPEED.onMiss);
    next.retiredAt = null; // a miss un-retires: it has to be 5 *straight*
  }
  return next;
}

export const isRetired = (card) => card.retiredAt !== null;

/**
 * Pick the next card: active cards only, least-recently-seen first, with ties
 * broken by lowest streak so the shakiest cards resurface soonest. Never
 * returns the card just answered unless it is the only one left.
 */
export function pickNext(cards, { exclude = null, random = Math.random } = {}) {
  const active = cards.filter((c) => !isRetired(c));
  if (active.length === 0) return null;

  const pool = active.length > 1 && exclude
    ? active.filter((c) => c.id !== exclude)
    : active;

  const never = pool.filter((c) => c.lastSeen === null);
  if (never.length > 0) return never[Math.floor(random() * never.length)];

  return pool.slice().sort((a, b) =>
    a.lastSeen - b.lastSeen || a.streak - b.streak
  )[0];
}

export function deckStats(cards) {
  const retired = cards.filter(isRetired).length;
  const attempts = cards.reduce((n, c) => n + c.attempts, 0);
  const hits = cards.reduce((n, c) => n + c.hits, 0);
  return {
    total: cards.length,
    retired,
    active: cards.length - retired,
    attempts,
    hits,
    accuracy: attempts === 0 ? null : hits / attempts,
  };
}
