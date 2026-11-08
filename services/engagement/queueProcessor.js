// services/engagement/queueProcessor.js
// -----------------------------------------------------------------------------
// NOTIFICATION QUEUE processing: claim → re-check → send → record.
//
// Claim: one conditional findOneAndUpdate PENDING → PROCESSING with a lease
// (lockedBy/lockedUntil). Two workers can never claim the same document.
//
// Before sending, everything is checked again against fresh data (the user may have
// changed settings, been suspended, blocked someone, or the event may be gone):
// account/devices/global opt-out, category toggle, category still enabled, this
// notification still owns the user's frequency slot, event still relevant, quiet hours.
//
// Crash safety: `inFlight` is set (in the same conditional update that counts the
// attempt) immediately before the FCM call. A lease that expires:
//   - without inFlight → the send never started → back to PENDING (no attempt lost);
//   - with inFlight    → FCM may have accepted it → DEAD_LETTER, possiblyDelivered,
//                        slot CONSUMED. It is never resent, so a crash cannot produce a
//                        second notification inside the window.
// -----------------------------------------------------------------------------
'use strict';

const User = require('../../models/User');
const EngagementNotification = require('../../models/EngagementNotification');
const { transition } = require('./queueStates');
const frequency = require('./frequency');
const eligibility = require('./eligibility');
const quietHours = require('./quietHours');
const { BY_EVENT_TYPE } = require('./sources');
const log = require('./log');

function retryDelayMs(cfg, attemptCount) {
  const list = cfg.retryDelaysSec;
  const i = Math.min(Math.max(attemptCount - 1, 0), list.length - 1);
  return list[i] * 1000;
}

async function claimNext(now, workerId, cfg) {
  return EngagementNotification.findOneAndUpdate(
    { status: 'PENDING', nextAttemptAt: { $lte: new Date(now) } },
    { $set: { status: 'PROCESSING', lockedBy: workerId, lockedUntil: new Date(now + cfg.claimLeaseMs), inFlight: false } },
    { sort: { nextAttemptAt: 1 }, new: true }
  ).lean();
}

const unlock = { lockedBy: null, lockedUntil: null, inFlight: false };

async function cancel(doc, reason, now) {
  const done = await transition(doc._id, 'PROCESSING', 'CANCELLED', {
    guard: { lockedBy: doc.lockedBy },
    set: { ...unlock, cancelledAt: new Date(now), cancelReason: reason, slotOutcome: 'RELEASED' },
  });
  if (done) await frequency.release(doc.userId, doc._id);
  return { result: 'CANCELLED', reason };
}

/** Everything that must still hold right before sending. Returns a reason or null. */
async function precheckSend(doc, user, now, cfg) {
  const acct = eligibility.evaluateAccount(user, now);
  if (!acct.eligible) return acct.reason;
  if (!cfg.enabledCategories.includes(doc.category)) return 'CATEGORY_NOT_ENABLED';
  const catIssue = eligibility.categoryIssue(user, doc.category);
  if (catIssue) return catIssue;
  if (!(await frequency.holds(doc.userId, doc._id))) return 'SLOT_NOT_HELD';
  if (doc.relevantUntil && new Date(doc.relevantUntil).getTime() <= now) return 'EVENT_STALE';
  const source = BY_EVENT_TYPE[doc.eventType];
  if (!source) return 'UNKNOWN_EVENT_TYPE';
  const check = await source.revalidate(doc, user, now, cfg);
  if (!check.ok) return check.reason || 'EVENT_NOT_RELEVANT';
  return null;
}

async function processOne(doc, { now, cfg, sender }) {
  const user = await User.findById(doc.userId).select(eligibility.USER_FIELDS).lean();
  const reason = await precheckSend(doc, user, now, cfg);
  if (reason) return cancel(doc, reason, now);

  // Quiet hours: put it back for the next permitted time (not an attempt), unless that
  // is too late for the event or beyond the maximum deferral.
  if (quietHours.isQuiet(user, now, cfg)) {
    const next = quietHours.nextPermittedTime(user, now, cfg).getTime();
    const tooLate = (doc.relevantUntil && next >= new Date(doc.relevantUntil).getTime())
      || next - new Date(doc.queuedAt || doc.scheduledAt).getTime() > cfg.maxDeferMs;
    if (tooLate) return cancel(doc, 'QUIET_HOURS_EXPIRED', now);
    await transition(doc._id, 'PROCESSING', 'PENDING', { guard: { lockedBy: doc.lockedBy }, set: { ...unlock, nextAttemptAt: new Date(next) } });
    return { result: 'DEFERRED' };
  }

  const tokens = eligibility.deviceTokens(user);
  const attemptAt = new Date(now);
  const started = await EngagementNotification.findOneAndUpdate(
    { _id: doc._id, status: 'PROCESSING', lockedBy: doc.lockedBy, inFlight: false },
    {
      // ($min would not work here: BSON orders null below every date.)
      $set: {
        inFlight: true, lastAttemptAt: attemptAt, lockedUntil: new Date(now + cfg.claimLeaseMs), 'fcm.deviceCount': tokens.length,
        ...(doc.firstAttemptAt ? {} : { firstAttemptAt: attemptAt }),
      },
      $inc: { attemptCount: 1 },
    },
    { new: true }
  ).lean();
  if (!started) return { result: 'LEASE_LOST' };

  const r = await sender.send(started, tokens);
  const entry = { at: attemptAt, outcome: r.outcome, code: r.code, successCount: r.successCount, failureCount: r.failureCount };
  const fcm = { 'fcm.successCount': r.successCount, 'fcm.failureCount': r.failureCount };
  const common = { guard: { lockedBy: doc.lockedBy, inFlight: true }, push: { attemptLog: entry }, inc: { 'fcm.invalidTokensRemoved': r.invalidTokensRemoved || 0 } };

  if (r.outcome === 'ACCEPTED') {
    await transition(doc._id, 'PROCESSING', 'SENT', { ...common, set: { ...unlock, ...fcm, fcmAcceptedAt: attemptAt, errorCode: null, slotOutcome: 'CONSUMED' } });
    await frequency.consume(doc.userId, doc._id, attemptAt, doc.category);
    log.info('fcm_accepted', { notificationId: String(doc._id), category: doc.category, attempt: started.attemptCount, devices: tokens.length, accepted: r.successCount });
    return { result: 'SENT' };
  }

  if (r.outcome === 'UNKNOWN') {
    await transition(doc._id, 'PROCESSING', 'DEAD_LETTER', { ...common, set: { ...unlock, ...fcm, failedAt: attemptAt, errorCode: r.code, possiblyDelivered: true, slotOutcome: 'CONSUMED' } });
    await frequency.consume(doc.userId, doc._id, attemptAt, doc.category);
    log.warn('dead_letter', { notificationId: String(doc._id), code: r.code, reason: 'OUTCOME_UNKNOWN' });
    return { result: 'DEAD_LETTER' };
  }

  if (r.outcome === 'TRANSIENT' && started.attemptCount < cfg.maxAttempts) {
    const next = new Date(now + retryDelayMs(cfg, started.attemptCount));
    await transition(doc._id, 'PROCESSING', 'PENDING', { ...common, set: { ...unlock, ...fcm, nextAttemptAt: next, errorCode: r.code } });
    log.warn('retry_scheduled', { notificationId: String(doc._id), code: r.code, attempt: started.attemptCount, inSeconds: Math.round((next - now) / 1000) });
    return { result: 'RETRY' };
  }

  const to = r.outcome === 'TRANSIENT' ? 'DEAD_LETTER' : 'FAILED';
  await transition(doc._id, 'PROCESSING', to, { ...common, set: { ...unlock, ...fcm, failedAt: attemptAt, errorCode: r.code, slotOutcome: 'RELEASED' } });
  await frequency.release(doc.userId, doc._id);
  log.warn(to === 'DEAD_LETTER' ? 'dead_letter' : 'fcm_failed', { notificationId: String(doc._id), code: r.code, attempt: started.attemptCount });
  return { result: to };
}

/** Leases that expired (worker died or hung). */
async function recoverStaleClaims(now, limit = 100) {
  const stale = await EngagementNotification.find({ status: 'PROCESSING', lockedUntil: { $lt: new Date(now) } })
    .select('_id userId category inFlight lastAttemptAt lockedUntil').limit(limit).lean();
  let requeued = 0, deadLettered = 0;
  for (const d of stale) {
    try {
      if (d.inFlight) {
        const done = await transition(d._id, 'PROCESSING', 'DEAD_LETTER', {
          guard: { inFlight: true, lockedUntil: { $lt: new Date(now) } },
          set: { ...unlock, failedAt: new Date(now), errorCode: 'OUTCOME_UNKNOWN_AFTER_CRASH', possiblyDelivered: true, slotOutcome: 'CONSUMED' },
        });
        if (done) {
          await frequency.consume(d.userId, d._id, d.lastAttemptAt || new Date(now), d.category);
          deadLettered++;
        }
      } else {
        const done = await transition(d._id, 'PROCESSING', 'PENDING', {
          guard: { inFlight: false, lockedUntil: { $lt: new Date(now) } },
          set: { ...unlock, nextAttemptAt: new Date(now) },
        });
        if (done) requeued++;
      }
    } catch (err) {
      log.error('stale_claim_recovery_error', { err: log.errTag(err) });
    }
  }
  if (requeued || deadLettered) log.warn('stale_claims_recovered', { requeued, deadLettered });
  return { requeued, deadLettered };
}

/**
 * Process due notifications until none are due, the send cap is reached or the time
 * budget runs out. One bad document never stops the loop.
 */
async function processDue({ cfg, workerId, sender, now = () => Date.now(), budgetMs = 60000, shouldStop = () => false }) {
  const startedAt = now();
  const summary = { claimed: 0, SENT: 0, RETRY: 0, DEFERRED: 0, CANCELLED: 0, FAILED: 0, DEAD_LETTER: 0, LEASE_LOST: 0, ERROR: 0, cancelReasons: {} };
  while (summary.claimed < cfg.maxSendsPerTick && !shouldStop() && now() - startedAt < budgetMs) {
    const t = now();
    const doc = await claimNext(t, workerId, cfg);
    if (!doc) break;
    summary.claimed++;
    try {
      const out = await processOne(doc, { now: t, cfg, sender });
      summary[out.result] = (summary[out.result] || 0) + 1;
      if (out.result === 'CANCELLED') summary.cancelReasons[out.reason] = (summary.cancelReasons[out.reason] || 0) + 1;
    } catch (err) {
      summary.ERROR++;
      log.error('process_error', { notificationId: String(doc._id), err: log.errTag(err) });
      // Hand it back unless a send may have started (then the lease recovery decides).
      try {
        await transition(doc._id, 'PROCESSING', 'PENDING', {
          guard: { lockedBy: workerId, inFlight: false },
          set: { ...unlock, nextAttemptAt: new Date(now() + retryDelayMs(cfg, 1)), errorCode: 'PROCESSING_ERROR' },
        });
      } catch (_) { /* the lease will expire and recovery will handle it */ }
    }
  }
  return summary;
}

module.exports = { processDue, processOne, claimNext, recoverStaleClaims, precheckSend, retryDelayMs };
