// services/engagement/adminQueries.js
// -----------------------------------------------------------------------------
// Phase 3: what the Admin Dashboard reads, plus the one queue write it may make (requeue).
// Everything here is aggregate or privacy-safe:
//   - a recipient is shown only as an 8-character hash reference, never an id, a name,
//     a token, a location or the rendered text (which can contain the user's city);
//   - every list is paginated and filtered server-side with allow-listed values;
//   - delivery is never inferred: "FCM accepted" is FCM acceptance; opens are only what
//     the app reported.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const EngagementNotification = require('../../models/EngagementNotification');
const EngagementWorkerLock = require('../../models/EngagementWorkerLock');
const EngagementGenerationBatch = require('../../models/EngagementGenerationBatch');
const EngagementTemplate = require('../../models/EngagementTemplate');
const EngagementPlannerDaily = require('../../models/EngagementPlannerDaily');
const config = require('../../config/engagementNotificationConfig');
const aiConfig = require('../../config/engagementAiConfig');
const control = require('./control');
const frequency = require('./frequency');
const { transition } = require('./queueStates');
const { audit } = require('./audit');
const log = require('./log');

const DAY = 24 * 3600 * 1000;
const IST_MS = 5.5 * 3600 * 1000;
const MAX_REQUEUES = 3;

const recipientRef = userId => crypto.createHash('sha256').update(`engagement-ref:${userId}`).digest('hex').slice(0, 8);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
const page = q => ({ page: int(q.page, 1, 1, 1000), limit: int(q.limit, 20, 1, 50) });
const oneOf = (v, allowed) => (typeof v === 'string' && allowed.includes(v.trim().toUpperCase()) ? v.trim().toUpperCase() : null);

/** 'YYYY-MM-DD' (Asia/Kolkata) → Date of 00:00 IST, or null. */
function istDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) ? new Date(t - IST_MS) : null;
}
const istKey = ms => new Date(ms + IST_MS).toISOString().slice(0, 10);

/** Validated [from, to) range in Asia/Kolkata days; default last 7 days; at most 92 days. */
function range(q, now = Date.now()) {
  const todayStart = istDate(istKey(now));
  const to = q.to ? istDate(q.to) : null;
  const from = q.from ? istDate(q.from) : null;
  if ((q.to && !to) || (q.from && !from)) return { ok: false, code: 'INVALID_DATE' };
  const end = to ? new Date(to.getTime() + DAY) : new Date(todayStart.getTime() + DAY);
  const start = from || new Date(end.getTime() - 7 * DAY);
  if (start >= end) return { ok: false, code: 'INVALID_RANGE' };
  if (end - start > 92 * DAY) return { ok: false, code: 'RANGE_TOO_LONG' };
  return { ok: true, start, end };
}

// ── Worker + queue monitoring ────────────────────────────────────────────────
/**
 * Worker state, derived on the server so the dashboard never shows "healthy" just because
 * an endpoint answered:
 *   DISABLED     ENGAGEMENT_WORKER_ENABLED is not true
 *   STOPPED      emergency stop is on
 *   NOT_RUNNING  enabled, but no heartbeat within 3 intervals (+60 s)
 *   ERROR        the last tick recorded errors
 *   PROCESSING   a tick is in progress
 *   IDLE         running normally between ticks
 */
function workerState(cfg, ctrl, hb, now) {
  if (!cfg.enabled) return 'DISABLED';
  if (ctrl.deliveryStopped) return 'STOPPED';
  const s = (hb && hb.lastSummary) || {};
  const last = hb && hb.lastRunAt ? new Date(hb.lastRunAt).getTime() : 0;
  if (!last || now - last > 3 * cfg.intervalMs + 60000) return 'NOT_RUNNING';
  if (s.lastErrorAt && (!s.lastOkAt || new Date(s.lastErrorAt) >= new Date(s.lastOkAt))) return 'ERROR';
  if (s.runningSince) return 'PROCESSING';
  return 'IDLE';
}

async function monitor(now = Date.now()) {
  const cfg = config.get();
  const ai = aiConfig.get();
  const [ctrl, hb, plannerLock, byStatus, retryable, oldest, staleClaims, lastSent, lastBatch, recentErrors, templateCounts] = await Promise.all([
    control.get(),
    EngagementWorkerLock.findById('heartbeat').lean(),
    EngagementWorkerLock.findById('planner').select('leaseUntil cursor cycleStartedAt cycleCompletedAt lastRunAt lastSummary').lean(),
    EngagementNotification.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    EngagementNotification.countDocuments({ status: 'PENDING', attemptCount: { $gt: 0 } }),
    EngagementNotification.findOne({ status: 'PENDING' }).sort({ nextAttemptAt: 1 }).select('nextAttemptAt createdAt').lean(),
    EngagementNotification.countDocuments({ status: 'PROCESSING', lockedUntil: { $lt: new Date(now) } }),
    EngagementNotification.findOne({ fcmAcceptedAt: { $ne: null } }).sort({ fcmAcceptedAt: -1 }).select('fcmAcceptedAt').lean(),
    EngagementGenerationBatch.findOne({}).sort({ startedAt: -1 }).select('status provider acceptedCount failureReason startedAt finishedAt').lean(),
    EngagementNotification.find({ errorCode: { $ne: null }, status: { $in: ['PENDING', 'FAILED', 'DEAD_LETTER'] } })
      .sort({ updatedAt: -1 }).limit(10).select('status errorCode updatedAt attemptCount category').lean(),
    EngagementTemplate.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const queue = Object.fromEntries(['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'DEAD_LETTER'].map(s => [s, 0]));
  for (const r of byStatus) queue[r._id] = r.n;
  const s = (hb && hb.lastSummary) || {};
  return {
    worker: {
      state: workerState(cfg, ctrl, hb, now),
      envEnabled: cfg.enabled, plannerEnabled: cfg.plannerEnabled, queueEnabled: cfg.queueEnabled,
      intervalSeconds: cfg.intervalMs / 1000,
      lastHeartbeatAt: hb ? hb.lastRunAt : null,
      lastTickAt: s.lastTickAt || null, lastTickMs: s.lastTickMs || null,
      lastOkAt: s.lastOkAt || null, lastErrorAt: s.lastErrorAt || null, lastErrorCodes: s.lastErrorCodes || [],
      processingSince: s.runningSince || null,
      lastPlanner: s.lastPlanner || null, lastQueue: s.lastQueue || null,
      plannerCycle: plannerLock ? { inProgress: !!plannerLock.cursor, cycleStartedAt: plannerLock.cycleStartedAt, cycleCompletedAt: plannerLock.cycleCompletedAt, lastRunAt: plannerLock.lastRunAt } : null,
    },
    controls: {
      deliveryStopped: !!ctrl.deliveryStopped, deliveryStoppedAt: ctrl.deliveryStoppedAt || null, deliveryStopReason: ctrl.deliveryStopReason || null,
      aiPaused: !!ctrl.aiPaused, aiPausedAt: ctrl.aiPausedAt || null,
    },
    queue: {
      ...queue,
      retryable,
      staleClaims,
      oldestPendingDueAt: oldest ? oldest.nextAttemptAt : null,
      oldestPendingQueuedAt: oldest ? oldest.createdAt : null,
    },
    lastFcmAcceptedAt: lastSent ? lastSent.fcmAcceptedAt : null,
    lastGeneration: lastBatch || null,
    recentErrors: recentErrors.map(e => ({ id: e._id, status: e.status, errorCode: e.errorCode, category: e.category, attempts: e.attemptCount, at: e.updatedAt })),
    templates: Object.fromEntries(templateCounts.map(r => [r._id, r.n])),
    ai: { envEnabled: ai.enabled, scheduleEnabled: ai.scheduleEnabled, paused: !!ctrl.aiPaused, primary: ai.primary, fallback: ai.fallback, approvalPolicy: ai.approvalPolicy },
  };
}

const QUEUE_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'DEAD_LETTER'];
const EVENT_TYPES = EngagementNotification.EVENT_TYPES;

function queueView(d) {
  return {
    id: d._id, recipientRef: recipientRef(d.userId), status: d.status, category: d.category, eventType: d.eventType,
    templateKey: d.templateKey, templateVersion: d.templateVersion, language: d.language || 'en',
    attemptCount: d.attemptCount, createdAt: d.createdAt, scheduledAt: d.scheduledAt, nextAttemptAt: d.nextAttemptAt,
    lastAttemptAt: d.lastAttemptAt, fcmAcceptedAt: d.fcmAcceptedAt, failedAt: d.failedAt, cancelledAt: d.cancelledAt,
    errorCode: d.errorCode, cancelReason: d.cancelReason, possiblyDelivered: !!d.possiblyDelivered, slotOutcome: d.slotOutcome,
    openedAt: d.openedAt, requeueCount: d.requeueCount || 0, requeuedAt: d.requeuedAt || null,
    requeueable: requeueBlocker(d, Date.now()) === null,
  };
}

/** Server-side filters; never title/body (rendered copy can include the user's city). */
async function listQueue(q = {}) {
  const filter = {};
  if (q.status !== undefined) { const s = oneOf(q.status, QUEUE_STATUSES); if (!s) return { ok: false, code: 'INVALID_FILTER', field: 'status' }; filter.status = s; }
  if (q.category !== undefined) { const c = oneOf(q.category, config.CATEGORIES); if (!c) return { ok: false, code: 'INVALID_FILTER', field: 'category' }; filter.category = c; }
  if (q.eventType !== undefined) { const e = oneOf(q.eventType, EVENT_TYPES); if (!e) return { ok: false, code: 'INVALID_FILTER', field: 'eventType' }; filter.eventType = e; }
  if (q.hasError === 'true') filter.errorCode = { $ne: null };
  const { page: p, limit } = page(q);
  const sort = filter.status === 'PENDING' ? { nextAttemptAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
  const [rows, total] = await Promise.all([
    EngagementNotification.find(filter).sort(sort).skip((p - 1) * limit).limit(limit)
      .select('-title -body -eventRef -idempotencyKey -eventKey -lockedBy').lean(),
    EngagementNotification.countDocuments(filter),
  ]);
  return { ok: true, items: rows.map(queueView), total, page: p, limit };
}

/** Why this notification may NOT be requeued, or null. */
function requeueBlocker(d, now) {
  if (!d) return 'NOT_FOUND';
  if (!['FAILED', 'DEAD_LETTER'].includes(d.status)) return 'NOT_FAILED';
  if (d.possiblyDelivered || d.fcmAcceptedAt) return 'POSSIBLY_DELIVERED';
  if (d.slotOutcome !== 'RELEASED') return 'SLOT_NOT_RELEASED';
  if ((d.requeueCount || 0) >= MAX_REQUEUES) return 'REQUEUE_LIMIT';
  if (d.relevantUntil && new Date(d.relevantUntil).getTime() <= now + 15 * 60 * 1000) return 'EVENT_NO_LONGER_RELEVANT';
  return null;
}

/**
 * Admin requeue of ONE failed notification — safe by construction:
 *   1. it must definitely never have reached FCM (not possibly delivered, slot released);
 *   2. the user's 72 h slot is re-reserved ATOMICALLY first (the same gate the planner uses),
 *      so a requeue can never create a second notification inside the window;
 *   3. then a conditional FAILED|DEAD_LETTER → PENDING transition (same document, same
 *      idempotency key — no duplicate); if that loses a race, the slot is released again;
 *   4. the worker re-checks everything before sending: account, preferences, quiet hours,
 *      blocks, event relevance, emergency stop.
 */
async function requeue(id, admin, { req, now = Date.now() } = {}) {
  if (!mongoose.isValidObjectId(id)) return { ok: false, code: 'NOT_FOUND' };
  const d = await EngagementNotification.findById(id).lean();
  const blocker = requeueBlocker(d, now);
  if (blocker) return { ok: false, code: blocker };
  const cfg = config.get();
  const slot = await frequency.reserve(d.userId, d._id, now, cfg.frequencyWindowMs);
  if (!slot.reserved) return { ok: false, code: 'FREQUENCY_LIMIT' };
  const moved = await transition(d._id, d.status, 'PENDING', {
    guard: { possiblyDelivered: { $ne: true }, slotOutcome: 'RELEASED', fcmAcceptedAt: null, requeueCount: d.requeueCount || 0 },
    set: {
      nextAttemptAt: new Date(now), attemptCount: 0, inFlight: false, lockedBy: null, lockedUntil: null,
      errorCode: null, failedAt: null, slotOutcome: 'HELD', requeuedAt: new Date(now), requeuedBy: admin._id,
    },
    inc: { requeueCount: 1 },
  });
  if (!moved) {
    await frequency.release(d.userId, d._id);
    return { ok: false, code: 'CONFLICT' };
  }
  log.warn('notification_requeued', { notificationId: String(d._id), from: d.status });
  await audit(admin, 'ENGAGEMENT_NOTIFICATION_REQUEUED', 'ENGAGEMENT_NOTIFICATION', d._id, { req, before: { status: d.status, errorCode: d.errorCode }, after: { status: 'PENDING' } });
  return { ok: true, item: queueView(moved) };
}

// ── Analytics ────────────────────────────────────────────────────────────────
// Counts a field only when it is set: $ifNull treats null AND missing as unset.
const nz = f => ({ $sum: { $cond: [{ $ifNull: [f, false] }, 1, 0] } });
const eq = (f, v) => ({ $sum: { $cond: [{ $eq: [f, v] }, 1, 0] } });
const STAGES = {
  queued: { $sum: 1 },
  attempted: nz('$firstAttemptAt'),
  fcmAccepted: nz('$fcmAcceptedAt'),
  failed: eq('$status', 'FAILED'),
  deadLettered: eq('$status', 'DEAD_LETTER'),
  cancelled: eq('$status', 'CANCELLED'),
  pending: { $sum: { $cond: [{ $in: ['$status', ['PENDING', 'PROCESSING']] }, 1, 0] } },
  retried: { $sum: { $cond: [{ $gt: ['$attemptCount', 1] }, 1, 0] } },
  possiblyDelivered: { $sum: { $cond: ['$possiblyDelivered', 1, 0] } },
  opened: nz('$openedAt'),
  featureOpened: nz('$featureOpenedAt'),
};

// Phase 1 planner skip codes, grouped for the dashboard. Anything unlisted → "other".
const SKIP_GROUPS = Object.freeze({
  frequency: ['FREQUENCY_WINDOW', 'SLOT_HELD', 'SLOT_UNAVAILABLE'],
  preferences: ['PUSH_DISABLED', 'ENGAGEMENT_DISABLED', 'CATEGORY_DISABLED'],
  quietHours: ['QUIET_HOURS_TOO_LONG'],
  account: ['USER_MISSING', 'DELETION_REQUESTED', 'NOT_USER_ROLE', 'NOT_ACTIVE', 'SUSPENDED', 'BANNED', 'RESTRICTED'],
  device: ['NO_VALID_DEVICE'],
  noOpportunity: ['NO_OPPORTUNITY', 'NO_RELEVANT_OPPORTUNITY', 'DUPLICATE_EVENT'],
});

async function analytics(q = {}, now = Date.now()) {
  const r = range(q, now);
  if (!r.ok) return r;
  const match = { createdAt: { $gte: r.start, $lt: r.end } };
  const tz = 'Asia/Kolkata';
  const [facet] = await EngagementNotification.aggregate([
    { $match: match },
    { $facet: {
      totals: [{ $group: { _id: null, ...STAGES } }],
      trend: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, ...STAGES } }, { $sort: { _id: 1 } }],
      byCategory: [{ $group: { _id: '$category', ...STAGES } }, { $sort: { queued: -1 } }],
      byLanguage: [{ $group: { _id: { $ifNull: ['$language', 'en'] }, ...STAGES } }, { $sort: { queued: -1 } }],
      byPurpose: [{ $group: { _id: '$eventType', ...STAGES } }, { $sort: { queued: -1 } }],
      byTemplate: [{ $group: { _id: { k: '$templateKey', v: '$templateVersion' }, category: { $first: '$category' }, ...STAGES } }, { $sort: { queued: -1 } }, { $limit: 50 }],
      cancelReasons: [{ $match: { status: 'CANCELLED' } }, { $group: { _id: '$cancelReason', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
      errorCodes: [{ $match: { errorCode: { $ne: null } } }, { $group: { _id: '$errorCode', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }],
    } },
  ]);
  const strip = rows => rows.map(({ _id, ...rest }) => ({ key: _id, ...rest }));
  const days = await EngagementPlannerDaily.find({ day: { $gte: r.start, $lt: r.end } }).sort({ day: 1 }).lean();
  const planner = { evaluated: 0, queued: 0, deferred: 0, errors: 0, skipped: {}, groups: {}, days: [] };
  for (const d of days) {
    planner.evaluated += d.evaluated || 0; planner.queued += d.queued || 0; planner.deferred += d.deferred || 0; planner.errors += d.evaluationErrors || 0;
    for (const [k, v] of Object.entries(d.skipped || {})) planner.skipped[k] = (planner.skipped[k] || 0) + v;
    planner.days.push({ day: d._id, evaluated: d.evaluated || 0, queued: d.queued || 0, skipped: Object.values(d.skipped || {}).reduce((a, b) => a + b, 0) });
  }
  for (const [g, codes] of Object.entries(SKIP_GROUPS)) planner.groups[g] = codes.reduce((a, c) => a + (planner.skipped[c] || 0), 0);
  const known = new Set(Object.values(SKIP_GROUPS).flat());
  planner.groups.other = Object.entries(planner.skipped).filter(([k]) => !known.has(k)).reduce((a, [, v]) => a + v, 0);
  const totals = (facet.totals[0] && (({ _id, ...t }) => t)(facet.totals[0])) || Object.fromEntries(Object.keys(STAGES).map(k => [k, 0]));
  const opensRecorded = await EngagementNotification.exists({ openedAt: { $ne: null } });
  return {
    ok: true,
    range: { from: istKey(r.start.getTime()), to: istKey(r.end.getTime() - 1), timeZone: tz },
    totals,
    trend: strip(facet.trend), byCategory: strip(facet.byCategory), byLanguage: strip(facet.byLanguage), byPurpose: strip(facet.byPurpose),
    byTemplate: facet.byTemplate.map(({ _id, ...rest }) => ({ templateKey: _id.k, templateVersion: _id.v, ...rest })),
    cancelReasons: strip(facet.cancelReasons), errorCodes: strip(facet.errorCodes),
    planner,
    planner_recordedSince: days.length ? days[0]._id : null,
    // What the backend can and cannot know. The dashboard shows "unavailable" for these.
    availability: {
      deviceDelivery: false,            // FCM does not report device delivery; acceptance only
      opens: !!opensRecorded,           // only when the Android app reports opens
      skippedByBlocks: false,           // blocks filter opportunities, not users; not counted separately
    },
  };
}

// ── Templates and generation history ─────────────────────────────────────────
async function versions(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const t = await EngagementTemplate.findById(id).select('templateId').lean();
  if (!t) return null;
  return EngagementTemplate.find({ templateId: t.templateId }).sort({ version: 1 }).lean();
}

const BATCH_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED'];
async function listBatches(q = {}, now = Date.now()) {
  const filter = {};
  if (q.status !== undefined) { const s = oneOf(q.status, BATCH_STATUSES); if (!s) return { ok: false, code: 'INVALID_FILTER', field: 'status' }; filter.status = s; }
  if (q.provider !== undefined) { if (!aiConfig.PROVIDERS.includes(String(q.provider).toLowerCase())) return { ok: false, code: 'INVALID_FILTER', field: 'provider' }; filter.provider = String(q.provider).toLowerCase(); }
  if (q.category !== undefined) { const c = oneOf(q.category, config.CATEGORIES); if (!c) return { ok: false, code: 'INVALID_FILTER', field: 'category' }; filter['request.category'] = c; }
  if (q.language !== undefined) { if (!aiConfig.LANGUAGES.includes(String(q.language).toLowerCase())) return { ok: false, code: 'INVALID_FILTER', field: 'language' }; filter['request.language'] = String(q.language).toLowerCase(); }
  if (q.from !== undefined || q.to !== undefined) {
    const r = range({ from: q.from, to: q.to }, now);
    if (!r.ok) return r;
    filter.createdAt = { $gte: r.start, $lt: r.end };
  }
  const { page: p, limit } = page(q);
  const [items, total] = await Promise.all([
    EngagementGenerationBatch.find(filter).sort({ startedAt: -1, _id: -1 }).skip((p - 1) * limit).limit(limit).lean(),
    EngagementGenerationBatch.countDocuments(filter),
  ]);
  return { ok: true, items, total, page: p, limit };
}

/** Per-provider generation outcomes over the last 7 days (from the batch history). */
async function providerStats(now = Date.now()) {
  const rows = await EngagementGenerationBatch.aggregate([
    { $match: { createdAt: { $gte: new Date(now - 7 * DAY) } } },
    { $unwind: '$attempts' },
    { $group: { _id: { p: '$attempts.provider', o: '$attempts.outcome' }, n: { $sum: 1 }, last: { $max: '$attempts.at' } } },
  ]);
  const out = {};
  for (const r of rows) {
    const p = (out[r._id.p] = out[r._id.p] || { ok: 0, failed: 0, skipped: 0, byOutcome: {} });
    p.byOutcome[r._id.o] = r.n;
    if (r._id.o === 'OK') p.ok += r.n; else if (r._id.o === 'SKIPPED') p.skipped += r.n; else p.failed += r.n;
  }
  return out;
}

module.exports = {
  monitor, listQueue, requeue, analytics, versions, listBatches, providerStats,
  _internal: { workerState, requeueBlocker, recipientRef, range, istDate, SKIP_GROUPS, MAX_REQUEUES },
};
