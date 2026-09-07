// services/aiHost/aiHostBudgetService.js
// -----------------------------------------------------------------------------
// R6.3 — the global spend ceiling for AI Host provider calls.
//
// R6.2 already prevents a Room from being nudged repeatedly (per-Room cooldown +
// atomic claim). This is the layer above that: no matter how many Rooms qualify,
// how many workers run, or what goes wrong, the AI Host cannot exceed a bounded
// number of provider calls per hour and per day.
//
// FAILS CLOSED. If the counters cannot be read or written — Redis down, Redis
// absent, any error — the budget is treated as exhausted and no provider call is
// made. Spending money is the risky direction; refusing to spend it is not.
//
// Reuses redisService.incrementWithWindow(), the same fixed-window primitive the
// Room rate limiters already use. No new Redis abstraction.
// -----------------------------------------------------------------------------
'use strict';

const redisService = require('../redisService');
const { AI_HOST_CONFIG } = require('./aiHostConfig');
const { emitAiHostEvent, AI_EVENT } = require('./aiHostTelemetry');

/**
 * Fixed windows keyed by clock bucket, so they roll over on their own and need
 * no cleanup. Namespaced under `aihost:` — cannot collide with R5's keys.
 */
const hourKey = (d = new Date()) => `aihost:budget:hour:${d.toISOString().slice(0, 13)}`;
const dayKey = (d = new Date()) => `aihost:budget:day:${d.toISOString().slice(0, 10)}`;

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;

/** True only when a real Redis client exists — the in-process map is not one. */
function redisAvailable() {
  try { return Boolean(redisService.getClient && redisService.getClient()); } catch (_) { return false; }
}

/**
 * Reads current usage without consuming any. For diagnostics and for the
 * scheduler's pre-flight check.
 *
 * @returns {Promise<{ok:boolean, callsThisHour:number, callsToday:number}>}
 *          ok:false means the counters are unreadable — treat as exhausted.
 */
async function getUsage() {
  if (!redisAvailable()) return { ok: false, callsThisHour: 0, callsToday: 0 };
  try {
    const [h, d] = await Promise.all([
      redisService.get(hourKey()),
      redisService.get(dayKey()),
    ]);
    return {
      ok: true,
      callsThisHour: typeof h === 'number' ? h : 0,
      callsToday: typeof d === 'number' ? d : 0,
    };
  } catch (err) {
    return { ok: false, callsThisHour: 0, callsToday: 0 };
  }
}

/**
 * Consumes ONE provider call from the budget.
 *
 * Increments first and compares afterwards — the increment is atomic in Redis,
 * so two concurrent callers cannot both see "one slot left" and both take it.
 * A caller that overshoots the limit is refused even though its increment
 * counted; the window is a ceiling, not an exact quota, and erring toward
 * refusing is the correct direction for spend.
 *
 * MUST be called before every provider request, including during dry-run, so
 * dry-run capacity numbers reflect what production would actually consume.
 *
 * @returns {Promise<{allowed:boolean, reason?:string, callsThisHour:number, callsToday:number, limit?:number, window?:string}>}
 */
async function consume({ aiInterventionId = null } = {}) {
  // Fail closed: no Redis means no way to bound spend.
  if (!redisAvailable()) {
    emitAiHostEvent(AI_EVENT.REDIS_UNAVAILABLE, { aiInterventionId, reason: 'budget_unavailable' });
    return { allowed: false, reason: 'redis_unavailable', callsThisHour: 0, callsToday: 0 };
  }

  let callsThisHour = 0;
  let callsToday = 0;
  try {
    callsThisHour = await redisService.incrementWithWindow(hourKey(), HOUR_SECONDS);
    callsToday = await redisService.incrementWithWindow(dayKey(), DAY_SECONDS);
  } catch (err) {
    emitAiHostEvent(AI_EVENT.REDIS_UNAVAILABLE, { aiInterventionId, reason: 'budget_write_failed' });
    return { allowed: false, reason: 'redis_error', callsThisHour: 0, callsToday: 0 };
  }

  if (callsThisHour > AI_HOST_CONFIG.MAX_CALLS_PER_HOUR) {
    emitAiHostEvent(AI_EVENT.BUDGET_EXHAUSTED, {
      aiInterventionId, window: 'hour', callsThisHour, limit: AI_HOST_CONFIG.MAX_CALLS_PER_HOUR,
    });
    return { allowed: false, reason: 'hourly_budget_exhausted', callsThisHour, callsToday, limit: AI_HOST_CONFIG.MAX_CALLS_PER_HOUR, window: 'hour' };
  }

  if (callsToday > AI_HOST_CONFIG.MAX_CALLS_PER_DAY) {
    emitAiHostEvent(AI_EVENT.BUDGET_EXHAUSTED, {
      aiInterventionId, window: 'day', callsToday, limit: AI_HOST_CONFIG.MAX_CALLS_PER_DAY,
    });
    return { allowed: false, reason: 'daily_budget_exhausted', callsThisHour, callsToday, limit: AI_HOST_CONFIG.MAX_CALLS_PER_DAY, window: 'day' };
  }

  return { allowed: true, callsThisHour, callsToday };
}

module.exports = {
  consume,
  getUsage,
  redisAvailable,
  hourKey,
  dayKey,
};
