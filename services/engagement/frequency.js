// services/engagement/frequency.js
// -----------------------------------------------------------------------------
// FREQUENCY ENFORCEMENT — at most one personal engagement notification per ACCOUNT in
// any rolling window (default 72 h), enforced by the database.
//
// The ledger is models/EngagementUserState.js (unique userId). Three operations, each a
// single conditional update that MongoDB applies atomically to one document:
//
//   reserve(user, id)  succeeds only if no notification currently owns the slot AND the
//                      last send is at least one window ago (or there was none). If two
//                      workers race, exactly one update matches; a racing upsert on a
//                      missing row hits the unique index (E11000) and is refused.
//   consume(user, id)  only the owner can: lastSentAt = max(lastSentAt, send time), slot freed.
//                      Used when FCM accepted the message, and when the outcome is UNKNOWN
//                      (it may have been delivered — counting it is the safe side).
//   release(user, id)  only the owner can: slot freed, lastSentAt untouched. Used only when
//                      the message definitely did not reach FCM (cancelled before sending,
//                      every device token rejected, retries exhausted on explicit errors).
//
// Retries reuse the SAME notification and the SAME reservation — a retry can never take
// a second slot. A deferred (quiet-hours) notification keeps its reservation until it is
// sent, so nothing else can be queued for that user meanwhile, and the 72 hours run from
// the actual send time. Login, logout, new devices and broadcasts never touch the ledger.
// -----------------------------------------------------------------------------
'use strict';

const EngagementUserState = require('../../models/EngagementUserState');
const EngagementNotification = require('../../models/EngagementNotification');
const log = require('./log');

async function reserve(userId, notificationId, now, windowMs) {
  const cutoff = new Date(now - windowMs);
  try {
    const doc = await EngagementUserState.findOneAndUpdate(
      { userId, activeNotificationId: null, $or: [{ lastSentAt: null }, { lastSentAt: { $lte: cutoff } }] },
      { $set: { activeNotificationId: notificationId, activeSince: new Date(now) }, $setOnInsert: { sentCount: 0 } },
      { upsert: true, new: true }
    ).lean();
    return { reserved: !!doc && String(doc.activeNotificationId) === String(notificationId) };
  } catch (err) {
    if (err && err.code === 11000) return { reserved: false, reason: 'SLOT_UNAVAILABLE' };
    throw err;
  }
}

async function consume(userId, notificationId, sentAt, category) {
  const r = await EngagementUserState.updateOne(
    { userId, activeNotificationId: notificationId },
    {
      $max: { lastSentAt: sentAt },
      $set: { activeNotificationId: null, activeSince: null, lastNotificationId: notificationId, lastCategory: category || null },
      $inc: { sentCount: 1 },
    }
  );
  return r.modifiedCount === 1;
}

async function release(userId, notificationId) {
  const r = await EngagementUserState.updateOne(
    { userId, activeNotificationId: notificationId },
    { $set: { activeNotificationId: null, activeSince: null } }
  );
  return r.modifiedCount === 1;
}

async function holds(userId, notificationId) {
  return !!(await EngagementUserState.exists({ userId, activeNotificationId: notificationId }));
}

/** Non-authoritative batch pre-check (saves work; reserve() is the real gate). */
function precheck(state, now, windowMs) {
  if (!state) return null;
  if (state.activeNotificationId) return 'SLOT_HELD';
  if (state.lastSentAt && new Date(state.lastSentAt).getTime() > now - windowMs) return 'FREQUENCY_WINDOW';
  return null;
}

/**
 * Self-healing for a worker that died between two steps:
 *   - reserved but never enqueued (no document) → release;
 *   - document already terminal but the slot was not settled → settle it the way the
 *     document says (SENT or possibly delivered → consume, otherwise release).
 * Reservations of live documents (PENDING / PROCESSING, including quiet-hours defers)
 * are left alone.
 */
async function recoverOrphans(now, cfg, limit = 200) {
  const stale = await EngagementUserState.find({
    activeNotificationId: { $type: 'objectId' },
    activeSince: { $lt: new Date(now - cfg.orphanReservationMs) },
  }).select('userId activeNotificationId').limit(limit).lean();
  let released = 0, consumed = 0;
  for (const s of stale) {
    try {
      const doc = await EngagementNotification.findById(s.activeNotificationId)
        .select('status possiblyDelivered fcmAcceptedAt lastAttemptAt category').lean();
      if (!doc) { if (await release(s.userId, s.activeNotificationId)) released++; continue; }
      if (doc.status === 'SENT' || doc.possiblyDelivered) {
        const at = doc.fcmAcceptedAt || doc.lastAttemptAt || new Date(now);
        if (await consume(s.userId, s.activeNotificationId, at, doc.category)) consumed++;
      } else if (['FAILED', 'CANCELLED', 'DEAD_LETTER'].includes(doc.status)) {
        if (await release(s.userId, s.activeNotificationId)) released++;
      }
    } catch (err) {
      log.error('orphan_recovery_error', { err: log.errTag(err) });
    }
  }
  if (released || consumed) log.info('orphan_reservations_settled', { released, consumed });
  return { released, consumed };
}

module.exports = { reserve, consume, release, holds, precheck, recoverOrphans };
