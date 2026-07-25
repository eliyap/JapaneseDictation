/** @import { Store, Scheduler, Sentence, CardState, ReviewInput } from './types.js' */

import { getScheduler, resolveParams, DEFAULT_SCHEDULER_ID } from "./scheduler/index.js";

// Orchestrates a review run. Knows about the store and the scheduler; knows
// nothing about the DOM, the network, or audio. That keeps the whole review
// loop testable without a browser.

export class Session {
  /**
   * @param {{ store: Store, schedulerId?: string, params?: Record<string, any>, now?: () => number }} deps
   */
  constructor({ store, schedulerId = DEFAULT_SCHEDULER_ID, params = {}, now = Date.now }) {
    this.store = store;
    this.now = now;
    this.setScheduler(schedulerId, params);
    /** @type {string|null} */
    this.currentId = null;
    this.revealed = false;
    this.shownAt = null;
  }

  setScheduler(schedulerId, storedParams = {}) {
    this.scheduler = getScheduler(schedulerId);
    this.params = resolveParams(this.scheduler, storedParams);
  }

  /** State for a sentence, creating it on first sight. */
  stateFor(sentenceId) {
    return this.store.getCard(sentenceId) ?? this.scheduler.init(this.params);
  }

  /** Everything due right now, soonest first. */
  queue() {
    const t = this.now();
    return this.store
      .listSentences()
      .filter((s) => !s.archived)
      .map((s) => ({ sentence: s, state: this.stateFor(s.id) }))
      .filter(({ state }) => this.scheduler.isDue(state, t))
      .sort((a, b) =>
        this.scheduler.priority(a.state, t) - this.scheduler.priority(b.state, t),
      );
  }

  counts() {
    const t = this.now();
    const all = this.store.listSentences().filter((s) => !s.archived);
    let due = 0;
    let retired = 0;
    for (const s of all) {
      const st = this.stateFor(s.id);
      if (st.retired) retired++;
      else if (this.scheduler.isDue(st, t)) due++;
    }
    return { total: all.length, due, retired, waiting: all.length - due - retired };
  }

  /**
   * Advance to the next card. Avoids immediately repeating the card just
   * answered unless it is the only thing due.
   * @returns {{ sentence: Sentence, state: CardState }|null}
   */
  next() {
    const q = this.queue();
    if (q.length === 0) {
      this.currentId = null;
      return null;
    }
    const pick = (q.length > 1 && this.currentId
      ? q.find((c) => c.sentence.id !== this.currentId) ?? q[0]
      : q[0]);

    this.currentId = pick.sentence.id;
    this.revealed = false;
    this.shownAt = this.now();
    return pick;
  }

  current() {
    if (!this.currentId) return null;
    const sentence = this.store.listSentences().find((s) => s.id === this.currentId);
    if (!sentence) return null;
    return { sentence, state: this.stateFor(this.currentId) };
  }

  reveal() {
    this.revealed = true;
  }

  /**
   * Record an answer for the current card and persist it.
   * @param {boolean} correct
   */
  answer(correct) {
    const cur = this.current();
    if (!cur) throw new Error("No card is being reviewed");

    const at = this.now();
    /** @type {ReviewInput} */
    const review = {
      correct,
      at,
      speed: cur.state.speed,
      elapsedMs: this.shownAt === null ? undefined : at - this.shownAt,
    };

    const nextState = this.scheduler.review(cur.state, review, this.params);
    this.store.putCard(cur.sentence.id, this.scheduler.id, nextState);
    this.store.logReview(cur.sentence.id, review, this.scheduler.id);
    return nextState;
  }

  /**
   * Adjust the current card's playback speed by hand without grading it.
   * Clamped to whatever range the active scheduler declares.
   */
  nudgeSpeed(delta) {
    const cur = this.current();
    if (!cur) return null;
    const lo = this.params.minSpeed ?? 0.5;
    const hi = this.params.maxSpeed ?? 1.1;
    const speed = Math.min(hi, Math.max(lo, Math.round((cur.state.speed + delta) * 100) / 100));
    const state = { ...cur.state, speed };
    this.store.putCard(cur.sentence.id, this.scheduler.id, state);
    return state;
  }
}
