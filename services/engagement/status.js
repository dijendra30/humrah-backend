// services/engagement/status.js
// Read-only operator status: switches (no secrets), queue counts by status, the last
// planner summary (aggregate counts), and analytics totals. No user ids, no content.
'use strict';

const config = require('../../config/engagementNotificationConfig');
const EngagementNotification = require('../../models/EngagementNotification');
const EngagementWorkerLock = require('../../models/EngagementWorkerLock');
const worker = require('./worker');

async function getStatus() {
  const cfg = config.get();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const EngagementTemplate = require('../../models/EngagementTemplate');
  const [templatesByStatus] = await Promise.all([
    EngagementTemplate.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const ai = require('../../config/engagementAiConfig').get();
  const extra = {
    templates: { ...Object.fromEntries(templatesByStatus.map(r => [r._id, r.n])), builtinFallback: cfg.builtinTemplatesEnabled, languageMode: cfg.languageMode },
    aiGeneration: { enabled: ai.enabled, scheduleEnabled: ai.scheduleEnabled, primary: ai.primary, fallback: ai.fallback, approvalPolicy: ai.approvalPolicy },
  };
  const [byStatus, lock, week] = await Promise.all([
    EngagementNotification.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    EngagementWorkerLock.findById('planner').select('leaseUntil cycleStartedAt cycleCompletedAt lastRunAt lastSummary').lean(),
    EngagementNotification.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: {
        _id: null,
        created: { $sum: 1 },
        attempted: { $sum: { $cond: [{ $ifNull: ['$firstAttemptAt', false] }, 1, 0] } },
        fcmAccepted: { $sum: { $cond: [{ $ifNull: ['$fcmAcceptedAt', false] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $ifNull: ['$failedAt', false] }, 1, 0] } },
        opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } },
        featureOpened: { $sum: { $cond: [{ $ifNull: ['$featureOpenedAt', false] }, 1, 0] } },
      } },
    ]),
  ]);
  const w = week[0] || {};
  return {
    ...extra,
    config: {
      enabled: cfg.enabled, plannerEnabled: cfg.plannerEnabled, queueEnabled: cfg.queueEnabled,
      intervalSeconds: cfg.intervalMs / 1000, batchSize: cfg.batchSize, maxSendsPerTick: cfg.maxSendsPerTick,
      frequencyHours: cfg.frequencyWindowMs / 3600000, maxAttempts: cfg.maxAttempts, retryDelaysSeconds: cfg.retryDelaysSec,
      quietHours: cfg.systemQuietEnabled ? { start: cfg.systemQuietStart, end: cfg.systemQuietEnd, timeZone: cfg.defaultTimeZone } : null,
      enabledCategories: cfg.enabledCategories,
    },
    thisInstance: worker.info(),
    queue: Object.fromEntries(byStatus.map(r => [r._id, r.n])),
    planner: lock ? {
      leaseHeld: !!(lock.leaseUntil && new Date(lock.leaseUntil) > new Date()),
      cycleStartedAt: lock.cycleStartedAt, cycleCompletedAt: lock.cycleCompletedAt, lastRunAt: lock.lastRunAt, lastSummary: lock.lastSummary,
    } : null,
    // FCM acceptance is not display; an open is reported by the app, not inferred.
    last7Days: {
      created: w.created || 0, attempted: w.attempted || 0, fcmAccepted: w.fcmAccepted || 0,
      failed: w.failed || 0, opened: w.opened || 0, featureOpened: w.featureOpened || 0,
    },
  };
}

module.exports = { getStatus };
