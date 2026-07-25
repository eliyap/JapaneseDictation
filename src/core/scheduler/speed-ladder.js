/** @import { Scheduler, CardState, ReviewInput } from '../types.js' */

// The original design: no calendar at all, just a speed ladder. Getting it
// right speeds the audio up, getting it wrong slows it down, and a card is
// done once you have taken it five times running. Everything is available
// immediately -- there is no "due tomorrow".
//
// Good for cramming a small deck. Bad for retention over months, which is
// what the interval schedulers are for.

const q2 = (n) => Math.round(n * 100) / 100;

/** @type {Scheduler} */
export const speedLadder = {
  id: "speed-ladder",
  label: "Speed ladder",
  description:
    "No spacing. Speed rises on a hit and falls on a miss; a card retires after " +
    "a run of correct answers. Best for drilling a small deck quickly.",

  params: [
    { key: "startSpeed", label: "Starting speed", type: "number", default: 0.8, min: 0.3, max: 1.5, step: 0.05, unit: "ratio" },
    { key: "minSpeed", label: "Slowest", type: "number", default: 0.5, min: 0.3, max: 1.5, step: 0.05, unit: "ratio" },
    { key: "maxSpeed", label: "Fastest", type: "number", default: 1.1, min: 0.3, max: 2.0, step: 0.05, unit: "ratio" },
    { key: "upStep", label: "Speed up by", type: "number", default: 0.05, min: 0.01, max: 0.5, step: 0.01, unit: "ratio" },
    { key: "downStep", label: "Slow down by", type: "number", default: 0.10, min: 0.01, max: 0.5, step: 0.01, unit: "ratio" },
    {
      key: "retireStreak", label: "Retire after", type: "number", default: 5, min: 1, max: 20, step: 1, unit: "count",
      help: "Consecutive correct answers needed to retire a card.",
    },
    {
      key: "retireAtMaxOnly", label: "Only retire at top speed", type: "boolean", default: false,
      help: "Require the run to happen at the fastest speed, not anywhere in the range.",
    },
  ],

  init(p) {
    return {
      due: null,
      speed: q2(p.startSpeed),
      reps: 0,
      lapses: 0,
      streak: 0,
      retired: false,
      algo: {},
    };
  },

  review(state, review, p) {
    const clamp = (n) => Math.min(p.maxSpeed, Math.max(p.minSpeed, q2(n)));
    const next = { ...state, algo: { ...state.algo }, reps: state.reps + 1 };

    if (review.correct) {
      next.streak = state.streak + 1;
      next.speed = clamp(state.speed + p.upStep);
      // Judge the run at the speed it was earned at, not the one it just
      // moved to -- otherwise the last answer of a run is credited to a speed
      // the learner has not actually been tested at yet.
      const fastEnough = !p.retireAtMaxOnly || review.speed >= p.maxSpeed - 1e-9;
      next.retired = next.streak >= p.retireStreak && fastEnough;
    } else {
      next.streak = 0;
      next.lapses = state.lapses + 1;
      next.speed = clamp(state.speed - p.downStep);
      next.retired = false;
    }

    next.due = review.at; // always immediately available
    return next;
  },

  isDue(state) {
    return !state.retired;
  },

  // Least-recently-reviewed first, with never-seen cards ahead of everything.
  priority(state) {
    return state.due ?? -Infinity;
  },
};
