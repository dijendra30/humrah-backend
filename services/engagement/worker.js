// services/engagement/worker.js
// -----------------------------------------------------------------------------
// The background worker. Started from server.js after MongoDB connects; it never runs
// inside a request and never blocks one (each tick is a chain of awaited DB calls on
// the event loop, bounded by batch size, send cap and a time budget).
//
// Off unless ENGAGEMENT_WORKER_ENABLED=true. Each tick:
//   1. maintenance — expired claim leases, orphaned slot reservations
//   2. planner     — (ENGAGEMENT_PLANNER_ENABLED) queue notifications for a few batches
//   3. queue       — (ENGAGEMENT_QUEUE_ENABLED) send what is due
// Ticks never overlap inside one process; a self-rescheduling timer is used instead of
// setInterval for that reason. Every step catches its own errors: server.js shuts the
// whole process down on an unhandled rejection, so nothing here may ever reject.
// stop() waits (bounded) for the current tick; anything left mid-way is recovered by
// the next tick on any instance (see queueProcessor / frequency recovery).
// -----------------------------------------------------------------------------
'use strict';

const os = require('os');
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config/engagementNotificationConfig');
const planner = require('./planner');
const queueProcessor = require('./queueProcessor');
const frequency = require('./frequency');
const delivery = require('./delivery');
const log = require('./log');

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

const state = { timer: null, running: null, stopping: false, started: false, lastTick: null, sender: null };

async function tick(opts = {}) {
  const cfg = opts.cfg || config.get();
  const sender = opts.sender || state.sender || (state.sender = delivery.defaultSender());
  const out = { at: new Date(), maintenance: null, planner: null, queue: null };
  if (mongoose.connection.readyState !== 1) { log.warn('tick_skipped', { reason: 'DB_NOT_CONNECTED' }); return out; }
  const shouldStop = () => state.stopping;
  const budgetMs = Math.max(10000, Math.floor(cfg.intervalMs * 0.6));

  try {
    const now = Date.now();
    out.maintenance = {
      claims: await queueProcessor.recoverStaleClaims(now),
      reservations: await frequency.recoverOrphans(now, cfg),
    };
  } catch (err) { log.error('maintenance_error', { err: log.errTag(err) }); }

  if (cfg.plannerEnabled && !shouldStop()) {
    try { out.planner = await planner.runPlanner({ cfg, workerId, shouldStop }); }
    catch (err) { log.error('planner_error', { err: log.errTag(err) }); }
  }

  if (cfg.queueEnabled && !shouldStop()) {
    try {
      out.queue = await queueProcessor.processDue({ cfg, workerId, sender, budgetMs, shouldStop });
      if (out.queue.claimed) log.info('queue_done', out.queue);
    } catch (err) { log.error('queue_error', { err: log.errTag(err) }); }
  }
  state.lastTick = { at: out.at, planner: out.planner ? { ran: out.planner.ran, queued: out.planner.queued || 0, reason: out.planner.reason || null } : null, queue: out.queue };
  return out;
}

function schedule(delayMs) {
  if (state.stopping) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.running = tick()
      .catch(err => log.error('tick_error', { err: log.errTag(err) }))
      .finally(() => {
        state.running = null;
        schedule(config.get().intervalMs);
      });
  }, delayMs);
  if (state.timer.unref) state.timer.unref();
}

function start() {
  try {
    const cfg = config.get();
    if (!cfg.enabled) {
      log.info('startup', { state: 'OFF', note: 'ENGAGEMENT_WORKER_ENABLED is not "true"; nothing is planned or sent.' });
      return false;
    }
    if (state.started) return true;
    state.started = true;
    state.stopping = false;
    log.info('startup', {
      state: 'ON', worker: workerId, intervalSeconds: cfg.intervalMs / 1000, batchSize: cfg.batchSize,
      maxSendsPerTick: cfg.maxSendsPerTick, frequencyHours: cfg.frequencyWindowMs / 3600000,
      categories: cfg.enabledCategories, planner: cfg.plannerEnabled, queue: cfg.queueEnabled,
      quietHours: cfg.systemQuietEnabled ? `${cfg.systemQuietStart}-${cfg.systemQuietEnd} ${cfg.defaultTimeZone}` : 'off',
    });
    // First tick shortly after boot, so a restart loop cannot send in a burst.
    schedule(30 * 1000);
    return true;
  } catch (err) {
    log.error('startup_error', { err: log.errTag(err) });
    return false;
  }
}

async function stop({ timeoutMs = 5000 } = {}) {
  state.stopping = true;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.running) {
    await Promise.race([state.running, new Promise(r => setTimeout(r, timeoutMs).unref())]);
  }
  if (state.started) log.info('shutdown', { worker: workerId });
  state.started = false;
}

function info() {
  return { workerId, started: state.started, ticking: !!state.running, lastTick: state.lastTick };
}

module.exports = { start, stop, tick, info, workerId };
