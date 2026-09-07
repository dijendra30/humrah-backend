// jobs/aiHostJob.js
// -----------------------------------------------------------------------------
// R6.3 — the operational trigger for the AI Host. R6.2 deliberately shipped
// without one; this is the smallest wiring that makes the feature activatable.
//
// TWO independent switches must BOTH be true before this job does anything:
//
//     AI_HOST_ENABLED=true      the master kill switch
//     AI_HOST_SCHEDULER_ENABLED=true
//
// AI_HOST_ENABLED alone does not start it, and AI_HOST_SCHEDULER_ENABLED alone
// cannot start it either. There is no configuration that produces AI work while
// the kill switch is off — asserted by test.
//
// Follows the existing Room job convention exactly (setInterval + distributed
// Redis lock + unref + delayed warm-up), the same shape as
// systemRoomGenerationJob and roomEngagementJob. No new scheduler framework.
// -----------------------------------------------------------------------------
'use strict';

const redisService = require('../services/redisService');
const HumrahRoom = require('../models/HumrahRoom');
const { AI_HOST_CONFIG } = require('../services/aiHost/aiHostConfig');
const { runAiHostIntervention } = require('../services/aiHost/aiHostConversationService');
const { emitAiHostEvent, AI_EVENT, newInterventionId } = require('../services/aiHost/aiHostTelemetry');
const aiHostBudget = require('../services/aiHost/aiHostBudgetService');
const { THRESHOLDS } = require('../services/roomEngagementService');

const WORKER_LOCK_KEY = 'lock:ai_host_worker';

let started = false;

/** Both switches, in one place. Neither alone is sufficient. */
function schedulerActive() {
  return AI_HOST_CONFIG.ENABLED === true && AI_HOST_CONFIG.SCHEDULER_ENABLED === true;
}

/** True only when a real Redis client exists — the in-process map is not one. */
function redisAvailable() {
  try { return Boolean(redisService.getClient && redisService.getClient()); } catch (_) { return false; }
}

/**
 * Candidate Rooms: lifecycle-engageable, at least two members, and with activity
 * inside R5's 24h engagement horizon. Served by the existing
 * { status: 1, lastMessageAt: 1 } index — R6.3 adds no index.
 *
 * The engine re-checks eligibility per Room; this only bounds what is looked at.
 */
async function findCandidateRooms(now = Date.now()) {
  const horizon = new Date(now - THRESHOLDS.QUIET_WINDOW_MS);
  return HumrahRoom.find({
    status: { $in: ['ACTIVE', 'FULL'] },
    lastMessageAt: { $gt: horizon },
    memberCount: { $gte: AI_HOST_CONFIG.MIN_MEMBERS },
  })
    .select('_id')
    .sort({ lastMessageAt: 1 })
    .limit(AI_HOST_CONFIG.MAX_ROOMS_SCANNED_PER_RUN)
    .lean();
}

/**
 * ONE scheduler pass. Always resolves — never throws into the interval.
 *
 * Bounded three ways: rooms scanned, actions attempted, and the global budget.
 * Stops early the moment the budget is exhausted rather than grinding through
 * the remaining Rooms.
 */
async function runAiHostPass(options = {}) {
  const summary = {
    roomsScanned: 0, roomsEligible: 0, roomsSkipped: 0,
    interventions: 0, failures: 0, durationMs: 0, skippedReason: null,
  };
  const started_ = Date.now();

  if (!schedulerActive() && options.force !== true) {
    summary.skippedReason = 'disabled';
    return summary;
  }
  // Idempotency and budget both need Redis; without it we do not generate.
  if (!redisAvailable()) {
    summary.skippedReason = 'redis_unavailable';
    emitAiHostEvent(AI_EVENT.REDIS_UNAVAILABLE, { reason: 'scheduler_precheck' });
    return summary;
  }

  let lockAcquired = false;
  try {
    lockAcquired = await redisService.acquireLock(WORKER_LOCK_KEY, AI_HOST_CONFIG.SCHEDULER_LOCK_TTL_SECONDS);
  } catch (err) {
    summary.skippedReason = 'lock_error';
    return summary;
  }
  if (!lockAcquired) {
    summary.skippedReason = 'already_running';
    return summary;
  }

  try {
    // Pre-flight: do not scan Mongo at all if the budget is already spent.
    const usage = await aiHostBudget.getUsage();
    if (!usage.ok ||
        usage.callsThisHour >= AI_HOST_CONFIG.MAX_CALLS_PER_HOUR ||
        usage.callsToday >= AI_HOST_CONFIG.MAX_CALLS_PER_DAY) {
      summary.skippedReason = 'budget_exhausted';
      emitAiHostEvent(AI_EVENT.BUDGET_EXHAUSTED, {
        reason: 'scheduler_precheck',
        callsThisHour: usage.callsThisHour, callsToday: usage.callsToday,
      });
      return summary;
    }

    const rooms = await findCandidateRooms(options.now || Date.now());
    summary.roomsScanned = rooms.length;

    for (const room of rooms) {
      if (summary.interventions >= AI_HOST_CONFIG.MAX_ACTIONS_PER_RUN) break;
      try {
        const outcome = await runAiHostIntervention({
          roomId: String(room._id),
          io: options.io || null,
          provider: options.provider || null,
          aiInterventionId: newInterventionId(),
        });
        if (outcome.outcome === 'DELIVERED') summary.interventions++;
        else if (outcome.outcome === 'DRY_RUN') { summary.roomsEligible++; summary.interventions++; }
        else if (outcome.outcome === 'BUDGET_EXHAUSTED') { summary.skippedReason = 'budget_exhausted'; break; }
        else summary.roomsSkipped++;
      } catch (roomErr) {
        // One Room's failure must never stop the pass.
        summary.failures++;
        console.error('[AI_HOST] scheduler room failed:', roomErr.message);
      }
    }

    summary.durationMs = Date.now() - started_;
    if (summary.interventions > 0 || summary.failures > 0) {
      emitAiHostEvent(AI_EVENT.RUN_SUMMARY, {
        roomsScanned: summary.roomsScanned,
        roomsSkipped: summary.roomsSkipped,
        interventions: summary.interventions,
        failures: summary.failures,
        totalLatencyMs: summary.durationMs,
      });
    }
    return summary;
  } catch (err) {
    summary.skippedReason = 'pass_error';
    summary.durationMs = Date.now() - started_;
    console.error('[AI_HOST] scheduler pass failed:', err.message);
    return summary;
  } finally {
    if (lockAcquired) {
      try { await redisService.releaseLock(WORKER_LOCK_KEY); } catch (_) { /* TTL clears it */ }
    }
  }
}

/**
 * Registers the recurring pass. Returns null (and logs once) unless BOTH
 * switches are on, so the normal production path is a single log line.
 */
function startAiHostJob(io) {
  if (!schedulerActive()) {
    console.log('[AI_HOST] Scheduler inactive (needs AI_HOST_ENABLED=true and AI_HOST_SCHEDULER_ENABLED=true).');
    return null;
  }
  if (started) {
    console.warn('[AI_HOST] Scheduler already started for this process — ignoring duplicate start.');
    return null;
  }
  started = true;

  const intervalMs = AI_HOST_CONFIG.SCHEDULER_INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `[AI_HOST] Scheduler active — every ${AI_HOST_CONFIG.SCHEDULER_INTERVAL_MINUTES} min, ` +
    `max ${AI_HOST_CONFIG.MAX_ACTIONS_PER_RUN}/run, ${AI_HOST_CONFIG.MAX_CALLS_PER_HOUR}/hr, ` +
    `${AI_HOST_CONFIG.MAX_CALLS_PER_DAY}/day` +
    `${AI_HOST_CONFIG.DRY_RUN ? ' (DRY RUN — nothing will be posted)' : ''}.`
  );

  const safeRun = () => {
    runAiHostPass({ io }).catch(err =>
      console.error('[AI_HOST] Unexpected scheduler error:', err.message)
    );
  };

  // Never run during boot: indexes, backfills and socket presence are still
  // settling, and a cold presence map would look like "nobody is inside".
  const warmup = setTimeout(safeRun, 5 * 60 * 1000);
  if (warmup.unref) warmup.unref();

  const handle = setInterval(safeRun, intervalMs);
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = { startAiHostJob, runAiHostPass, findCandidateRooms, schedulerActive, WORKER_LOCK_KEY };
