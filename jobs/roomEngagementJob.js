// jobs/roomEngagementJob.js
// -----------------------------------------------------------------------------
// R5.2 — periodic driver for the Room engagement engine.
//
// Follows the existing Humrah Room job convention exactly (setInterval + Redis
// lock + unref + delayed warm-up), the same shape as systemRoomGenerationJob and
// the invitation worker. No new queue framework, no node-cron dependency added.
//
// Safety properties:
//   - default OFF (ROOM_ENGAGEMENT_ENABLED)
//   - starts once per server process, after MongoDB is connected
//   - the pass itself holds a distributed Redis lock, so overlapping runs and
//     multiple instances cannot both act
//   - every error is caught; the scheduler can never crash the server
//   - handles are unref'd so they never hold the process open
// -----------------------------------------------------------------------------
'use strict';

const { runEngagementPass, ENGAGEMENT_CONFIG } = require('../services/roomEngagementActionService');

let started = false;

/**
 * Registers the recurring engagement pass.
 * @param {object} io Socket.IO server — required for live Room presence checks.
 * @returns {?object} the interval handle, or null when disabled/already started
 */
function startRoomEngagementJob(io) {
  if (!ENGAGEMENT_CONFIG.ENABLED) {
    console.log('[ROOM_ENGAGEMENT] Disabled (ROOM_ENGAGEMENT_ENABLED != true) — no engagement actions will be taken.');
    return null;
  }
  if (started) {
    console.warn('[ROOM_ENGAGEMENT] Job already started for this process — ignoring duplicate start.');
    return null;
  }
  started = true;

  const intervalMs = ENGAGEMENT_CONFIG.INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `[ROOM_ENGAGEMENT] Enabled — every ${ENGAGEMENT_CONFIG.INTERVAL_MINUTES} min, ` +
    `max ${ENGAGEMENT_CONFIG.MAX_ACTIONS_PER_RUN} actions/run` +
    `${ENGAGEMENT_CONFIG.DRY_RUN ? ' (DRY RUN — nothing will be sent)' : ''}.`
  );

  const safeRun = () => {
    runEngagementPass({ io }).catch(err =>
      console.error('[ROOM_ENGAGEMENT] Unexpected scheduler error:', err.message)
    );
  };

  // Never evaluate during boot: indexes, backfills and socket presence are still
  // settling, and a cold presence map would look like "nobody is inside".
  const warmup = setTimeout(safeRun, 5 * 60 * 1000);
  if (warmup.unref) warmup.unref();

  const handle = setInterval(safeRun, intervalMs);
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = { startRoomEngagementJob };
