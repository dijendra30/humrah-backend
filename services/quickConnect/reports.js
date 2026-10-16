// services/quickConnect/reports.js
// -----------------------------------------------------------------------------
// Quick Connect: report (and optionally block) the other person of a session.
//
// The client only names the SESSION. The server checks the caller was a participant and
// resolves the other person itself — the client never learns or sends their user id.
// Order, so the reported person can never be matched with the reporter again in between:
//   1. block (existing blockedUsers, same write as settingsController.blockUser) or, without
//      a block, a skip exclusion (QuickConnectPairExclusion);
//   2. end the session if it is still open (both phones disconnect; holds released);
//   3. record one SafetyReport per reporter per session (the existing moderation queue the
//      admin dashboard reads), deduplicated by a QuickConnectReport marker.
// Reports are allowed for open sessions and for 24 h after a session ended, and keep
// working while the feature is switched off. Nothing about the call's content exists to
// attach: calls are not recorded.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const User = require('../../models/User');
const SafetyReport = require('../../models/SafetyReport');
const QuickConnectSession = require('../../models/QuickConnectSession');
const QuickConnectReport = require('../../models/QuickConnectReport');
const matching = require('./matching');
const lifecycle = require('./lifecycle');

/** App reason → existing SafetyReport category. */
const REASONS = {
  HARASSMENT: 'HARASSMENT',
  SEXUAL_OR_INAPPROPRIATE: 'INAPPROPRIATE_CONTENT',
  HATE_OR_THREATS: 'THREATENING',
  UNDERAGE: 'UNDERAGE_USER',
  SPAM_OR_SCAM: 'SPAM_SCAM',
  OTHER: 'OTHER'
};
const URGENT_REASONS = new Set(['UNDERAGE', 'HATE_OR_THREATS']);
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DETAILS = 1000;

const fail = code => ({ ok: false, code });
const isId = v => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.isValidObjectId(v);

/**
 * Resolves { ok: true, alreadyReported, blocked, ended } or { ok: false, code } with code
 * INVALID_REQUEST | SESSION_NOT_FOUND | REPORT_WINDOW_CLOSED. Never returns the peer's id.
 */
async function reportPeer(userId, body, { now = Date.now() } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !isId(b.sessionId) || typeof b.reason !== 'string' || !REASONS[b.reason]) return fail('INVALID_REQUEST');
  if (b.details !== undefined && b.details !== null && (typeof b.details !== 'string' || b.details.length > MAX_DETAILS)) return fail('INVALID_REQUEST');
  if (b.block !== undefined && typeof b.block !== 'boolean') return fail('INVALID_REQUEST');
  const block = b.block === true;
  const details = typeof b.details === 'string' ? b.details.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim() : '';

  const s = await QuickConnectSession.findOne({ _id: b.sessionId, participants: userId })
    .select('participants status connectedAt endedAt').lean();
  if (!s) return fail('SESSION_NOT_FOUND');
  const open = QuickConnectSession.ACTIVE_STATUSES.includes(s.status);
  if (!open && s.endedAt && now - new Date(s.endedAt).getTime() > REPORT_WINDOW_MS) return fail('REPORT_WINDOW_CLOSED');
  const peer = s.participants.map(String).find(p => p !== String(userId));
  if (!peer) return fail('SESSION_NOT_FOUND');

  // 1. Keep them apart first.
  if (block) {
    await User.updateOne({ _id: userId }, { $addToSet: { blockedUsers: peer } });
  } else {
    try { await matching.excludeSkippedPair(userId, peer, { now }); } catch (err) {
      console.error('[quick-connect] report exclusion write failed:', err && err.name);
    }
  }

  // 2. Disconnect both phones now.
  let ended = false;
  if (open) ended = (await lifecycle.finishSession(s._id, block ? 'blocked' : 'hangup', { endedBy: userId })).ended;

  // 3. One moderation report per reporter per session.
  const markerId = `${String(s._id)}:${String(userId)}`;
  try {
    await QuickConnectReport.create({ _id: markerId, sessionId: s._id, reporterId: userId, createdAt: new Date(now) });
  } catch (err) {
    if (err && err.code === 11000) return { ok: true, alreadyReported: true, blocked: block, ended };
    throw err;
  }
  try {
    const description = `Quick Connect voice call report (session ${String(s._id)}; ` +
      `${s.connectedAt ? 'call was connected' : 'call never connected'}; status when reported: ${s.status}; ` +
      `reporter ${block ? 'also blocked' : 'did not block'} this person).` +
      (details ? `\nReporter's note: ${details}` : '');
    const report = await SafetyReport.create({
      reporterId: userId,
      reportedUserId: peer,
      category: REASONS[b.reason],
      description: description.slice(0, 2000),
      priority: URGENT_REASONS.has(b.reason) ? 'URGENT' : 'HIGH',
      status: 'PENDING'
    });
    await QuickConnectReport.updateOne({ _id: markerId }, { $set: { safetyReportId: report._id } });
  } catch (err) {
    await QuickConnectReport.deleteOne({ _id: markerId }).catch(() => {});   // let a retry file it
    throw err;
  }
  return { ok: true, alreadyReported: false, blocked: block, ended };
}

module.exports = { reportPeer, REASONS, REPORT_WINDOW_MS, MAX_DETAILS };
