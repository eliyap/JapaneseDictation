/** @import { Scheduler } from '../types.js' */

// FSRS drop-in point.
//
// This is deliberately NOT a hand-rolled FSRS. FSRS is a fitted model: its
// behaviour lives in a 17-21 element weight vector trained on review history,
// and an implementation with guessed weights schedules badly while looking
// plausible. Shipping invented constants would be worse than shipping nothing.
//
// So this file is the adapter instead. Give it a real FSRS implementation --
// `ts-fsrs` is the obvious one -- and it becomes a Scheduler like any other:
//
//   import { fsrs as engine, generatorParameters, Rating, State } from "ts-fsrs";
//   import { makeFsrsScheduler } from "./fsrs.js";
//   register(makeFsrsScheduler({ engine, generatorParameters, Rating }));
//
// The prerequisite that actually matters is already in place: every answer is
// written to the `reviews` table with its timestamp, so there is a real review
// log to train weights on from day one. Retrofitting that later would have
// meant starting the history over.

const DAY = 86_400_000;

/**
 * Wrap a `ts-fsrs`-shaped engine as a Scheduler.
 *
 * The binary correct/wrong signal maps to Good/Again. FSRS distinguishes
 * Hard and Easy as well, and collapsing them loses real information -- if you
 * ever want that back, it has to come from the UI offering more than two
 * buttons, not from anything this adapter can infer.
 *
 * @param {{ engine: Function, generatorParameters: Function, Rating: any }} deps
 * @param {{ weights?: number[] }} [opts]
 * @returns {Scheduler}
 */
export function makeFsrsScheduler(deps, opts = {}) {
  const { engine, generatorParameters, Rating } = deps;

  return {
    id: "fsrs",
    label: "FSRS",
    description:
      "Free Spaced Repetition Scheduler, driven by weights fitted to your own " +
      "review history. Requires a ts-fsrs-compatible engine to be supplied.",

    params: [
      { key: "requestRetention", label: "Target retention", type: "number", default: 0.9, min: 0.7, max: 0.98, step: 0.01, unit: "ratio" },
      { key: "maximumInterval", label: "Maximum interval", type: "number", default: 365, min: 1, max: 3650, step: 1, unit: "days" },
      { key: "startSpeed", label: "Starting speed", type: "number", default: 0.8, min: 0.3, max: 1.5, step: 0.05, unit: "ratio" },
      { key: "minSpeed", label: "Slowest", type: "number", default: 0.5, min: 0.3, max: 1.5, step: 0.05, unit: "ratio" },
      { key: "maxSpeed", label: "Fastest", type: "number", default: 1.1, min: 0.3, max: 2.0, step: 0.05, unit: "ratio" },
      { key: "upStep", label: "Speed up by", type: "number", default: 0.05, min: 0.01, max: 0.5, step: 0.01, unit: "ratio" },
      { key: "downStep", label: "Slow down by", type: "number", default: 0.10, min: 0.01, max: 0.5, step: 0.01, unit: "ratio" },
    ],

    init(p) {
      return {
        due: null,
        speed: p.startSpeed,
        reps: 0,
        lapses: 0,
        streak: 0,
        retired: false,
        // FSRS's own state lives here untouched by the app -- exactly what the
        // `algo` blob exists for. No schema change was needed to add it.
        algo: { stability: null, difficulty: null, state: "new", lastReview: null },
      };
    },

    review(state, review, p) {
      const f = engine(
        generatorParameters({
          request_retention: p.requestRetention,
          maximum_interval: p.maximumInterval,
          ...(opts.weights ? { w: opts.weights } : {}),
        }),
      );

      const card = {
        due: new Date(state.due ?? review.at),
        stability: state.algo.stability ?? 0,
        difficulty: state.algo.difficulty ?? 0,
        elapsed_days: state.algo.lastReview ? (review.at - state.algo.lastReview) / DAY : 0,
        scheduled_days: 0,
        reps: state.reps,
        lapses: state.lapses,
        state: state.algo.state === "new" ? 0 : 2,
        last_review: state.algo.lastReview ? new Date(state.algo.lastReview) : undefined,
      };

      const rating = review.correct ? Rating.Good : Rating.Again;
      const result = f.repeat(card, new Date(review.at))[rating].card;

      const clamp = (n) =>
        Math.min(p.maxSpeed, Math.max(p.minSpeed, Math.round(n * 100) / 100));

      return {
        due: new Date(result.due).getTime(),
        speed: clamp(state.speed + (review.correct ? p.upStep : -p.downStep)),
        reps: state.reps + 1,
        lapses: state.lapses + (review.correct ? 0 : 1),
        streak: review.correct ? state.streak + 1 : 0,
        retired: false, // FSRS keeps scheduling; it has no notion of "done"
        algo: {
          stability: result.stability,
          difficulty: result.difficulty,
          state: "review",
          lastReview: review.at,
        },
      };
    },

    isDue(state, now) {
      return !state.retired && (state.due === null || state.due <= now);
    },

    priority(state) {
      return state.due ?? -Infinity;
    },
  };
}
