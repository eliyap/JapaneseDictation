/** @import { Scheduler, ParamSpec } from '../types.js' */

import { speedLadder } from "./speed-ladder.js";
import { sm2 } from "./sm2.js";

/** @type {Map<string, Scheduler>} */
const registry = new Map();

/** @param {Scheduler} scheduler */
export function register(scheduler) {
  for (const required of ["id", "label", "params", "init", "review", "isDue", "priority"]) {
    if (scheduler?.[required] === undefined) {
      throw new Error(`Scheduler is missing "${required}"`);
    }
  }
  registry.set(scheduler.id, scheduler);
  return scheduler;
}

register(speedLadder);
register(sm2);

export const listSchedulers = () => [...registry.values()];

/** Falls back to the default rather than throwing, so an unknown id in a
 *  synced database never bricks the app on another device. */
export function getScheduler(id) {
  return registry.get(id) ?? registry.get(DEFAULT_SCHEDULER_ID);
}

export const DEFAULT_SCHEDULER_ID = speedLadder.id;

/** @param {Scheduler} scheduler */
export function defaultParams(scheduler) {
  return Object.fromEntries(scheduler.params.map((p) => [p.key, p.default]));
}

/**
 * Merge stored params over the defaults and coerce to the declared type, so a
 * settings blob written by an older version (or a hand-edited one) can't feed
 * NaN into an algorithm.
 *
 * @param {Scheduler} scheduler
 * @param {Record<string, unknown>} stored
 */
export function resolveParams(scheduler, stored = {}) {
  const out = {};
  for (const spec of scheduler.params) {
    const raw = stored?.[spec.key];
    out[spec.key] = coerce(spec, raw);
  }
  return out;
}

/** @param {ParamSpec} spec */
function coerce(spec, raw) {
  if (raw === undefined || raw === null || raw === "") return spec.default;

  if (spec.type === "boolean") {
    return typeof raw === "boolean" ? raw : raw === "true" || raw === 1 || raw === "1";
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return spec.default;
  const lo = spec.min ?? -Infinity;
  const hi = spec.max ?? Infinity;
  return Math.min(hi, Math.max(lo, n));
}
