// services/quickConnect/sessions.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 4): reserving people for a session and releasing them.
// Server-side only — no route creates a session in Phase 4 (matching comes later,
// and must run evaluateEligibility for BOTH users before calling createSession).
//
// One call per person across Agora AND Quick Connect: both use the same
// voicecallreservations hold (_id = userId, so a claim is an atomic insert).
// Quick Connect holds carry kind 'qc'. People are claimed in sorted id order, the
// same rule /api/voice-call/initiate uses, so crossing requests resolve to exactly
// one winner. No multi-document transaction is needed or used.
//
// Release paths (every one conditional on the exact hold):
//   cancellation / failure / hangup / timeout  -> endSession(id, reason)
//   stale sessions (crash, lost process)       -> sweepStaleSessions(), and lazily by
//                                                 any later claim (holdIsOver, kind 'qc')
//   disconnect detection                       -> later phase (socket heartbeats) calls endSession
// endSession and sweepStaleSessions work even while QUICK_CONNECT_ENABLED is off, so
// switching the feature off never strands anyone in a "busy" state.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const VoiceCallReservation = require('../../models/VoiceCallReservation');
const QuickConnectSession = require('../../models/QuickConnectSession');
const config = require('./config');

const QC = VoiceCallReservation.QC_KIND;
const STATUS_FOR_REASON = { cancelled: 'CANCELLED', setup_failed: 'FAILED', system_error: 'FAILED' };

async function releaseHolds(session) {
  await Promise.all(session.participants.map(uid => VoiceCallReservation.release(uid, session._id)));
}

/**
 * Reserves two users and creates an ACCEPTED session ending at most MAX_DURATION from now.
 * Resolves { ok: true, session } or { ok: false, code } with code
 *   QUICK_CONNECT_DISABLED | INVALID_PARTICIPANTS | BUSY (busyUserId names who).
 */
async function createSession(userA, userB, { now = Date.now() } = {}) {
  if (!config.isEnabled()) return { ok: false, code: 'QUICK_CONNECT_DISABLED' };
  const ids = [String(userA).toLowerCase(), String(userB).toLowerCase()];
  if (!ids.every(id => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(id)) || ids[0] === ids[1]) {
    return { ok: false, code: 'INVALID_PARTICIPANTS' };
  }
  ids.sort();

  const sessionId = new mongoose.Types.ObjectId();
  const claimed = [];
  for (const uid of ids) {
    if (await VoiceCallReservation.claim(uid, sessionId, QC)) { claimed.push(uid); continue; }
    await Promise.all(claimed.map(u => VoiceCallReservation.release(u, sessionId)));
    return { ok: false, code: 'BUSY', busyUserId: uid };
  }

  try {
    const session = await QuickConnectSession.create({
      _id: sessionId,
      participants: ids,
      status: 'ACCEPTED',
      acceptedAt: new Date(now),
      endsAt: new Date(now + QuickConnectSession.MAX_DURATION_MS)
    });
    return { ok: true, session };
  } catch (err) {
    await Promise.all(claimed.map(u => VoiceCallReservation.release(u, sessionId)));
    throw err;
  }
}

/**
 * Ends an active session (conditional: never rewrites one that already ended) and
 * releases both holds. Holds are released even when the session had already ended,
 * so a retry always cleans up. Resolves { ended: boolean }.
 */
async function endSession(sessionId, reason = 'hangup', { endedBy = null } = {}) {
  if (!mongoose.isValidObjectId(sessionId)) return { ended: false };
  if (!QuickConnectSession.END_REASONS.includes(reason)) throw new Error('unknown end reason');
  const status = STATUS_FOR_REASON[reason] || 'ENDED';
  const updated = await QuickConnectSession.findOneAndUpdate(
    { _id: sessionId, status: { $in: QuickConnectSession.ACTIVE_STATUSES } },
    { $set: { status, endReason: reason, endedAt: new Date(), endedBy } },
    { new: true }
  ).lean();
  const session = updated || await QuickConnectSession.findById(sessionId).select('participants').lean();
  if (session) await releaseHolds(session);
  return { ended: !!updated };
}

/** Ends sessions that are stale by their own rules and releases their holds. Returns how many. */
async function sweepStaleSessions({ now = Date.now(), limit = 100 } = {}) {
  const stale = await QuickConnectSession.find({
    $and: [{ status: { $in: QuickConnectSession.ACTIVE_STATUSES } }, QuickConnectSession.staleActiveFilter(now)]
  }).select('_id participants').limit(limit).lean();
  let ended = 0;
  for (const s of stale) {
    const res = await QuickConnectSession.updateOne(
      { $and: [{ _id: s._id }, QuickConnectSession.staleActiveFilter(now)] },
      { $set: { status: 'ENDED', endReason: 'stale_cleanup', endedAt: new Date() } }
    );
    if (res.modifiedCount > 0) ended++;
    await releaseHolds(s);
  }
  return ended;
}

/**
 * The active, non-stale session `sessionId` if `userId` is one of its participants,
 * otherwise null. Used to decide who may receive TURN credentials.
 */
async function findActiveSessionFor(sessionId, userId, { now = Date.now() } = {}) {
  if (!mongoose.isValidObjectId(sessionId) || !mongoose.isValidObjectId(userId)) return null;
  return QuickConnectSession.findOne({
    $and: [
      { _id: sessionId, participants: userId, status: { $in: QuickConnectSession.ACTIVE_STATUSES } },
      { $nor: [QuickConnectSession.staleActiveFilter(now)] }
    ]
  }).select('_id participants status endsAt').lean();
}

/** True while `userId` is in an active, non-stale session other than `exceptSessionId`. */
async function hasOtherActiveSession(userId, exceptSessionId, { now = Date.now() } = {}) {
  const filter = { participants: userId, status: { $in: QuickConnectSession.ACTIVE_STATUSES } };
  if (exceptSessionId && mongoose.isValidObjectId(exceptSessionId)) filter._id = { $ne: exceptSessionId };
  return !!(await QuickConnectSession.exists({ $and: [filter, { $nor: [QuickConnectSession.staleActiveFilter(now)] }] }));
}

module.exports = { createSession, endSession, sweepStaleSessions, findActiveSessionFor, hasOtherActiveSession };
