/** @import { Scheduler } from '../types.js' */

// SuperMemo-2, adapted to a binary correct/wrong signal.
//
// Classic SM-2 takes a 0-5 self-rating. Grading here happens on paper and only
// produces a bit, so this maps correct -> quality 4 and wrong -> quality 2 and
// keeps the standard ease-factor update. That is the usual binary adaptation
// and it behaves sensibly; it just cannot distinguish "easy" from "barely".
//
// Speed is carried alongside the interval, using the same ladder rules, so
// switching from the speed-ladder scheduler does not lose that behaviour.

const DAY = 86_400_000;
const q2 = (n) => Math.round(n * 100) / 100;

/** @type {Scheduler} */
export const sm2 = {
  id: "sm2",
  label: "SM-2 (spaced)",
  description:
    "Classic SuperMemo-2 intervals driven by a correct/wrong signal, with the " +
    "speed ladder layered on top. Cards come back on a growing schedule.",

  params: [
    { key: "startSpeed", label: "Starting speed", type: "number", default: 0.8, min: 0.3, max: 1.5, step: 0.05, unit: "ratio" },
    { key: "minSpeed", label: "Slowest", type: "number", default: 0.5, min: 0.3, max: 1.5, step: 0.05, unit: "ratio" },
    { key: "maxSpeed", label: "Fastest", type: "number", default: 1.1, min: 0.3, max: 2.0, step: 0.05, unit: "ratio" },
    { key: "upStep", label: "Speed up by", type: "number", default: 0.05, min: 0.01, max: 0.5, step: 0.01, unit: "ratio" },
    { key: "downStep", label: "Slow down by", type: "number", default: 0.10, min: 0.01, max: 0.5, step: 0.01, unit: "ratio" },

    { key: "firstInterval", label: "First interval", type: "number", default: 1, min: 0, max: 30, step: 0.5, unit: "days" },
    { key: "secondInterval", label: "Second interval", type: "number", default: 6, min: 1, max: 60, step: 1, unit: "days" },
    { key: "startingEase", label: "Starting ease", type: "number", default: 2.5, min: 1.3, max: 4.0, step: 0.1 },
    { key: "minEase", label: "Minimum ease", type: "number", default: 1.3, min: 1.1, max: 2.5, step: 0.1 },
    {
      key: "lapseInterval", label: "Interval after a lapse", type: "number", default: 0, min: 0, max: 10, step: 0.5, unit: "days",
      help: "0 means the card comes straight back in the same session.",
    },
    {
      key: "retireIntervalDays", label: "Retire once interval exceeds", type: "number", default: 180, min: 0, max: 3650, step: 30, unit: "days",
      help: "0 disables retirement -- cards keep coming back forever.",
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
      algo: { ease: p.startingEase, intervalDays: 0 },
    };
  },

  review(state, review, p) {
    const clamp = (n) => Math.min(p.maxSpeed, Math.max(p.minSpeed, q2(n)));
    const ease = Number(state.algo.ease ?? p.startingEase);
    const next = { ...state, algo: { ...state.algo }, reps: state.reps + 1 };

    // SM-2's ease update, with quality pinned to 4 (correct) or 2 (wrong).
    const quality = review.correct ? 4 : 2;
    const nextEase = Math.max(
      p.minEase,
      ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
    );
    next.algo.ease = q2(nextEase);

    let intervalDays;
    if (review.correct) {
      next.streak = state.streak + 1;
      next.speed = clamp(state.speed + p.upStep);
      if (next.streak === 1) intervalDays = p.firstInterval;
      else if (next.streak === 2) intervalDays = p.secondInterval;
      else intervalDays = Number(state.algo.intervalDays || p.secondInterval) * nextEase;
    } else {
      next.streak = 0;
      next.lapses = state.lapses + 1;
      next.speed = clamp(state.speed - p.downStep);
      intervalDays = p.lapseInterval;
    }

    next.algo.intervalDays = q2(intervalDays);
    next.due = review.at + intervalDays * DAY;
    next.retired = p.retireIntervalDays > 0 && intervalDays >= p.retireIntervalDays;
    return next;
  },

  isDue(state, now) {
    if (state.retired) return false;
    return state.due === null || state.due <= now;
  },

  priority(state) {
    return state.due ?? -Infinity;
  },
};
