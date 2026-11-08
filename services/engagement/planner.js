// services/engagement/planner.js
// -----------------------------------------------------------------------------
// The planner: walks the users collection in _id order, a bounded batch at a time, and
// for each user independently decides whether ONE notification is worth queueing.
//
//   eligibility → frequency pre-check → send time (quiet hours) → personalisation →
//   opportunities → already-notified filter → selection → atomic slot reservation →
//   enqueue (unique idempotency key)
//
// Memory: one batch of lean users (ENGAGEMENT_BATCH_SIZE, default 100) at a time; the
// cursor (last _id) is persisted, so a restart resumes where the pass stopped.
// Multi-instance: a database lease ('planner') lets only one instance plan at a time.
// Correctness never depends on the lease — the slot reservation and the unique
// idempotency key make a duplicate impossible even if two planners overlapped.
// After a complete pass it rests for ENGAGEMENT_CYCLE_REST_MINUTES.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const User = require('../../models/User');
const EngagementNotification = require('../../models/EngagementNotification');
const EngagementUserState = require('../../models/EngagementUserState');
const EngagementWorkerLock = require('../../models/EngagementWorkerLock');
const eligibility = require('./eligibility');
const frequency = require('./frequency');
const quietHours = require('./quietHours');
const personalisation = require('./personalisation');
const { collectAll } = require('./sources');
const selection = require('./selection');
const templates = require('./templates');
const templateStore = require('./templateStore');
const log = require('./log');

const LOCK_ID = 'planner';

/**
 * Phase 2: ACTIVE templates, loaded ONCE per planner run (never per user, never from an
 * AI provider). If the load fails, planning continues with the built-in templates only.
 */
async function loadTemplatePool(cfg) {
  try {
    const stored = await templateStore.loadActiveTemplates();
    return templates.buildPool(stored, { builtinsEnabled: cfg.builtinTemplatesEnabled });
  } catch (err) {
    log.error('template_pool_load_failed', { err: log.errTag(err) });
    return templates.buildPool([], { builtinsEnabled: cfg.builtinTemplatesEnabled });
  }
}
const { ObjectId } = mongoose.Types;

const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

/** Acquire or renew the planner lease. Returns the lock document, or null if another instance holds it. */
async function acquireLease(workerId, now, leaseMs) {
  try {
    return await EngagementWorkerLock.findOneAndUpdate(
      { _id: LOCK_ID, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date(now) } }, { owner: workerId }] },
      { $set: { owner: workerId, leaseUntil: new Date(now + leaseMs) } },
      { upsert: true, new: true }
    ).lean();
  } catch (err) {
    if (err && err.code === 11000) return null;   // the row exists and someone else holds it
    throw err;
  }
}

async function releaseLease(workerId, fields = {}) {
  await EngagementWorkerLock.updateOne({ _id: LOCK_ID, owner: workerId }, { $set: { leaseUntil: null, ...fields } });
}

async function saveProgress(workerId, now, leaseMs, fields) {
  const r = await EngagementWorkerLock.updateOne(
    { _id: LOCK_ID, owner: workerId },
    { $set: { ...fields, leaseUntil: new Date(now + leaseMs) } }
  );
  return r.matchedCount === 1;
}

/**
 * Decide for ONE user. Returns { outcome, reason } — never throws for expected cases.
 */
async function planUser(user, state, { now, cfg, shared }) {
  const acct = eligibility.evaluateAccount(user, now);
  if (!acct.eligible) return { outcome: 'SKIPPED', reason: acct.reason };

  const freq = frequency.precheck(state, now, cfg.frequencyWindowMs);
  if (freq) return { outcome: 'SKIPPED', reason: freq };

  const scheduledAt = quietHours.nextPermittedTime(user, now, cfg);
  if (scheduledAt.getTime() - now > cfg.maxDeferMs) return { outcome: 'SKIPPED', reason: 'QUIET_HOURS_TOO_LONG' };

  if (shared && !shared.templatePool) shared.templatePool = await loadTemplatePool(cfg);
  const ctx = await personalisation.buildContext(user, { now, cfg, shared });
  const { opportunities, errors } = await collectAll(ctx);
  for (const e of errors) log.error('source_error', { source: e.source, err: log.errTag(e.err) });
  if (opportunities.length === 0) return { outcome: 'SKIPPED', reason: 'NO_OPPORTUNITY' };

  const keys = opportunities.map(o => `${user._id}:${o.eventKey}`);
  const already = await EngagementNotification.find({ idempotencyKey: { $in: keys } }).select('eventKey').lean();
  const notifiedKeys = new Set(already.map(a => a.eventKey));

  const { chosen } = selection.choose(opportunities, ctx, { cfg, scheduledAt, notifiedKeys });
  if (!chosen) return { outcome: 'SKIPPED', reason: 'NO_RELEVANT_OPPORTUNITY' };

  const notificationId = new ObjectId();
  const slot = await frequency.reserve(user._id, notificationId, now, cfg.frequencyWindowMs);
  if (!slot.reserved) return { outcome: 'SKIPPED', reason: 'SLOT_UNAVAILABLE' };

  try {
    await EngagementNotification.create({
      _id: notificationId,
      userId: user._id,
      category: chosen.category,
      templateKey: chosen.rendered.templateKey,
      templateVersion: chosen.rendered.templateVersion,
      language: chosen.rendered.language,
      title: chosen.rendered.title,
      body: chosen.rendered.body,
      eventType: chosen.eventType,
      eventRef: chosen.eventRef,
      eventKey: chosen.eventKey,
      idempotencyKey: `${user._id}:${chosen.eventKey}`,
      relevantUntil: chosen.relevantUntil || null,
      status: 'PENDING',
      priority: chosen.priority,
      score: chosen.score,
      scheduledAt,
      nextAttemptAt: scheduledAt,
      queuedAt: new Date(now),
    });
  } catch (err) {
    await frequency.release(user._id, notificationId);
    if (err && err.code === 11000) return { outcome: 'SKIPPED', reason: 'DUPLICATE_EVENT' };
    throw err;
  }
  const deferred = scheduledAt.getTime() > now;
  if (chosen.rendered.templateDocId) {
    try { await templateStore.recordUsage(chosen.rendered.templateDocId, new Date(now)); }
    catch (err) { log.warn('template_usage_record_failed', { err: log.errTag(err) }); }
  }
  log.info('notification_queued', {
    notificationId: String(notificationId), category: chosen.category, eventType: chosen.eventType,
    templateKey: chosen.rendered.templateKey, templateVersion: chosen.rendered.templateVersion, language: chosen.rendered.language,
    score: chosen.score, deferred, candidates: opportunities.length,
  });
  return { outcome: 'QUEUED', reason: chosen.category, deferred };
}

async function planBatch(users, { now, cfg, shared }) {
  const summary = { users: users.length, queued: 0, deferred: 0, skipped: {}, errors: 0, categories: {} };
  const states = await EngagementUserState.find({ userId: { $in: users.map(u => u._id) } })
    .select('userId lastSentAt activeNotificationId').lean();
  const stateBy = new Map(states.map(s => [String(s.userId), s]));
  for (const user of users) {
    try {
      const r = await planUser(user, stateBy.get(String(user._id)), { now, cfg, shared });
      if (r.outcome === 'QUEUED') {
        summary.queued++;
        bump(summary.categories, r.reason);
        if (r.deferred) summary.deferred++;
      } else bump(summary.skipped, r.reason);
    } catch (err) {
      summary.errors++;
      log.error('plan_user_error', { err: log.errTag(err) });
    }
  }
  return summary;
}

/**
 * One planner run: up to ENGAGEMENT_MAX_BATCHES_PER_TICK batches.
 */
async function runPlanner({ cfg, workerId, now = () => Date.now(), shouldStop = () => false }) {
  const t0 = now();
  const lock = await acquireLease(workerId, t0, cfg.leaseMs);
  if (!lock) { log.info('lock_conflict', { lock: LOCK_ID }); return { ran: false, reason: 'LOCK_HELD' }; }

  let cursor = lock.cursor || null;
  if (!cursor && lock.cycleCompletedAt && t0 - new Date(lock.cycleCompletedAt).getTime() < cfg.cycleRestMs) {
    await releaseLease(workerId);
    return { ran: false, reason: 'RESTING' };
  }
  const total = { batches: 0, users: 0, queued: 0, deferred: 0, errors: 0, skipped: {}, categories: {} };
  try {
    if (!cursor) await saveProgress(workerId, t0, cfg.leaseMs, { cycleStartedAt: new Date(t0) });

    const shared = {};   // per-run memo (e.g. the Room candidates)
    for (let b = 0; b < cfg.maxBatchesPerTick && !shouldStop(); b++) {
      const t = now();
      const query = {
        status: 'ACTIVE', role: 'USER', deletionRequestedAt: null, 'fcmTokens.0': { $exists: true },
        ...(cursor ? { _id: { $gt: cursor } } : {}),
      };
      const users = await User.find(query).sort({ _id: 1 }).limit(cfg.batchSize).select(eligibility.USER_FIELDS).lean();
      if (users.length === 0) {
        cursor = null;
        await saveProgress(workerId, t, cfg.leaseMs, { cursor: null, cycleCompletedAt: new Date(t) });
        log.info('cycle_complete', {});
        break;
      }
      const s = await planBatch(users, { now: t, cfg, shared });
      cursor = users[users.length - 1]._id;
      total.batches++; total.users += s.users; total.queued += s.queued; total.deferred += s.deferred; total.errors += s.errors;
      for (const [k, v] of Object.entries(s.skipped)) total.skipped[k] = (total.skipped[k] || 0) + v;
      for (const [k, v] of Object.entries(s.categories)) total.categories[k] = (total.categories[k] || 0) + v;
      log.info('batch_done', { batch: b + 1, users: s.users, queued: s.queued, deferred: s.deferred, errors: s.errors, categories: s.categories, skipped: s.skipped });
      if (!(await saveProgress(workerId, now(), cfg.leaseMs, { cursor }))) {
        log.warn('lease_lost', { lock: LOCK_ID });
        return { ran: true, ...total, leaseLost: true };
      }
    }
    return { ran: true, ...total };
  } finally {
    try { await releaseLease(workerId, { lastRunAt: new Date(now()), lastSummary: total }); } catch (_) { /* expires anyway */ }
  }
}

module.exports = { runPlanner, planUser, planBatch, acquireLease, releaseLease, loadTemplatePool, LOCK_ID };
