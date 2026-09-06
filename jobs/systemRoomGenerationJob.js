// jobs/systemRoomGenerationJob.js
// -----------------------------------------------------------------------------
// PHASE 1: production driver for the (previously dormant) System Room Generator.
//
//   eligible users  →  roomCandidateService  →  R3.1 matching + R3.2 grouping
//                   →  SUGGESTED HumrahRooms →  existing R3.3 invitation worker
//
// This job creates Rooms ONLY. It never sends FCM, never writes notification copy,
// and never auto-joins anyone — services/roomInvitationService.js already picks up
// SYSTEM + SUGGESTED Rooms every 5 minutes and owns all invitation delivery.
//
// Safety: kill switch, distributed Redis lock, bounded candidate + room caps,
// per-user cooldown, DB duplicate prevention, and it can never crash the server.
// -----------------------------------------------------------------------------
'use strict';

const redisService = require('../services/redisService');
const { generateSystemRooms, CONFIG } = require('../services/systemRoomGeneratorService');
const {
  loadRoomCandidates,
  bucketCandidatesByCity,
  markUsersExposed,
  CANDIDATE_CONFIG,
} = require('../services/roomCandidateService');

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const GENERATOR_CONFIG = {
  // Default OFF. Generation must be switched on deliberately, per deployment.
  ENABLED: String(process.env.ROOM_GENERATOR_ENABLED || 'false').trim().toLowerCase() === 'true',
  INTERVAL_MINUTES: num(process.env.ROOM_GENERATOR_INTERVAL_MINUTES, 60),
  MAX_ROOMS_PER_RUN: num(process.env.ROOM_GENERATOR_MAX_ROOMS_PER_RUN, CONFIG.MAX_ROOMS_PER_RUN),
  LOCK_TTL_SECONDS: num(process.env.ROOM_GENERATOR_LOCK_TTL_SECONDS, 300),
};

const LOCK_KEY = 'lock:system_room_generation';

/**
 * True when we can guarantee only one generation worker runs across all instances.
 * redisService falls back to an in-process map when Redis is absent, which is NOT
 * a distributed lock — so in production we refuse to run rather than risk two
 * workers generating duplicate Rooms concurrently.
 */
function canGuaranteeSingleWorker() {
  if (redisService.getClient && redisService.getClient()) return true;
  return process.env.NODE_ENV !== 'production';
}

/**
 * One generation run. Always resolves — never throws into the scheduler.
 * @returns {Promise<Object>} structured run summary
 */
async function runSystemRoomGeneration(options = {}) {
  const summary = {
    event: 'system_room_generation',
    generation_started: new Date().toISOString(),
    enabled: GENERATOR_CONFIG.ENABLED,
    candidates_found: 0,
    candidates_eligible: 0,
    city_batches: 0,
    groups_considered: 0,
    groups_rejected: 0,
    rooms_created: 0,
    rooms_skipped_duplicate: 0,
    rooms_skipped_quality: 0,
    rejection_reasons: {},
    generation_duration_ms: 0,
    generation_failed: false,
    skipped_reason: null,
  };
  const started = Date.now();

  // ── Kill switch ────────────────────────────────────────────────────────────
  if (!GENERATOR_CONFIG.ENABLED && options.force !== true) {
    summary.skipped_reason = 'generator_disabled';
    summary.generation_duration_ms = Date.now() - started;
    return summary;
  }

  if (!canGuaranteeSingleWorker()) {
    summary.skipped_reason = 'redis_unavailable';
    summary.generation_duration_ms = Date.now() - started;
    console.warn('[RoomGenerator] Skipped: Redis unavailable, cannot guarantee a single worker.');
    return summary;
  }

  // ── Distributed lock ───────────────────────────────────────────────────────
  let lockAcquired = false;
  try {
    lockAcquired = await redisService.acquireLock(LOCK_KEY, GENERATOR_CONFIG.LOCK_TTL_SECONDS);
  } catch (err) {
    summary.skipped_reason = 'lock_error';
    summary.generation_failed = true;
    summary.generation_duration_ms = Date.now() - started;
    console.error('[RoomGenerator] Lock acquisition failed:', err.message);
    return summary;
  }
  if (!lockAcquired) {
    summary.skipped_reason = 'already_running';
    summary.generation_duration_ms = Date.now() - started;
    return summary;
  }

  try {
    // ── Candidate population ─────────────────────────────────────────────────
    const { candidates, stats } = await loadRoomCandidates();
    summary.candidates_found = stats.candidatesFound;
    summary.candidates_eligible = stats.candidatesEligible;
    summary.excluded_cooldown = stats.excludedCooldown;
    summary.excluded_pending_invite = stats.excludedPendingInvite;
    summary.excluded_too_many_rooms = stats.excludedTooManyRooms;

    if (candidates.length < CONFIG.MIN_GROUP_SIZE) {
      summary.skipped_reason = 'insufficient_candidates';
      summary.generation_duration_ms = Date.now() - started;
      console.log('[RoomGenerator]', JSON.stringify(summary));
      return summary;
    }

    // ── Local (per-city) batches + All-India pool ────────────────────────────
    const { cityBatches, allIndiaPool } = bucketCandidatesByCity(candidates, {
      minGroupSize: CONFIG.MIN_GROUP_SIZE,
      cityBatchSize: CANDIDATE_CONFIG.CITY_BATCH_SIZE,
    });
    summary.city_batches = cityBatches.length;

    let roomBudget = options.maxRooms || GENERATOR_CONFIG.MAX_ROOMS_PER_RUN;
    const exposedUserIds = [];

    const applyRunLog = (runLog) => {
      summary.groups_considered += runLog.groupsEvaluated;
      summary.groups_rejected += runLog.groupsRejected;
      summary.rooms_created += runLog.roomsCreated;
      for (const [reason, count] of Object.entries(runLog.rejections || {})) {
        summary.rejection_reasons[reason] = (summary.rejection_reasons[reason] || 0) + count;
        if (reason === 'duplicate_room_exists') summary.rooms_skipped_duplicate += count;
      }
      (runLog.createdRooms || []).forEach(r => exposedUserIds.push(...(r.members || [])));
      roomBudget -= runLog.roomsCreated;
    };

    // Local generation first — geographically coherent Rooms are the stronger product.
    for (const batch of cityBatches) {
      if (roomBudget <= 0) break;
      const runLog = await generateSystemRooms(batch.users, {
        discoveryMode: 'NEAR_ME',
        maxRooms: roomBudget,
        silent: true,
      });
      applyRunLog(runLog);
    }

    // All India — compatibility + language driven, no proximity requirement.
    if (roomBudget > 0 && allIndiaPool.length >= CONFIG.MIN_GROUP_SIZE) {
      const runLog = await generateSystemRooms(allIndiaPool, {
        discoveryMode: 'ALL_INDIA',
        maxRooms: roomBudget,
        silent: true,
      });
      applyRunLog(runLog);
    }

    // groups that produced no Room and were not duplicates were quality rejections
    summary.rooms_skipped_quality = Math.max(
      0,
      summary.groups_rejected - summary.rooms_skipped_duplicate
    );

    // ── Exposure cooldown for everyone actually placed in a Room ─────────────
    if (exposedUserIds.length > 0) {
      await markUsersExposed([...new Set(exposedUserIds.map(String))]);
    }

    summary.generation_duration_ms = Date.now() - started;
    console.log('[RoomGenerator]', JSON.stringify(summary));
    return summary;
  } catch (err) {
    // A failed run must never crash the server or leave Rooms half-built
    // (createSystemRoom rolls back its own partial writes).
    summary.generation_failed = true;
    summary.generation_duration_ms = Date.now() - started;
    summary.error = err.message;
    console.error('[RoomGenerator] Generation run failed:', err.message);
    return summary;
  } finally {
    if (lockAcquired) {
      try {
        await redisService.releaseLock(LOCK_KEY);
      } catch (releaseErr) {
        // TTL will clear it; never mask the original outcome.
        console.error('[RoomGenerator] Lock release failed (TTL will expire it):', releaseErr.message);
      }
    }
  }
}

/** Registers the recurring generation run using the existing setInterval job pattern. */
function startSystemRoomGenerationJob() {
  if (!GENERATOR_CONFIG.ENABLED) {
    console.log('[RoomGenerator] Disabled (ROOM_GENERATOR_ENABLED != true) — no Rooms will be generated.');
    return null;
  }
  const intervalMs = GENERATOR_CONFIG.INTERVAL_MINUTES * 60 * 1000;
  console.log(`[RoomGenerator] Enabled — running every ${GENERATOR_CONFIG.INTERVAL_MINUTES} min (max ${GENERATOR_CONFIG.MAX_ROOMS_PER_RUN} Rooms/run).`);

  // Delayed first run: never generate during boot (indexes/backfills still settling),
  // but don't starve generation on a server that restarts often.
  const warmup = setTimeout(() => {
    runSystemRoomGeneration().catch(err =>
      console.error('[RoomGenerator] Unexpected warmup error:', err.message)
    );
  }, 2 * 60 * 1000);
  if (warmup.unref) warmup.unref();

  const handle = setInterval(() => {
    runSystemRoomGeneration().catch(err =>
      console.error('[RoomGenerator] Unexpected scheduler error:', err.message)
    );
  }, intervalMs);
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = {
  GENERATOR_CONFIG,
  LOCK_KEY,
  runSystemRoomGeneration,
  startSystemRoomGenerationJob,
  canGuaranteeSingleWorker,
};
