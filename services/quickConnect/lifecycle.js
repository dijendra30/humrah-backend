// services/quickConnect/lifecycle.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 5): server-authoritative session lifecycle.
//
//   PROPOSED --both accept--> ACCEPTED --first offer--> CONNECTING --connected--> CONNECTED
//   PROPOSED --decline / 15 s timeout / blocked / moderation / switched off--> CANCELLED
//            (a decline also keeps the two from being matched again for a while)
//   ACCEPTED|CONNECTING|CONNECTED --hangup, heartbeat timeout, 30 min, moderation,
//                                   block, phone takeover, switched off--> ENDED
//   ACCEPTED|CONNECTING not CONNECTED within 2 min --> FAILED (setup_timeout)
// Every transition is ONE conditional write on the current state, so repeated or
// concurrent requests can never move a session backwards or revive an ended one.
// Ending always releases both reservations (services/quickConnect/sessions.js) and
// tells both people (qc_session_ended).
//
// Time limits live in MongoDB (proposedAt, acceptedAt, endsAt, lastSeenAt — server
// clock only), so they survive restarts. The sweeper (startSweeper) enforces them every
// QUICK_CONNECT_SWEEP_INTERVAL_MS (default 10 s) and ALWAYS runs, also while the feature
// is switched off — then it ends every open session (feature_disabled) and clears searches.
//
// Reconnect policy: a socket disconnect never ends a call. The call ends only when the
// participant's last heartbeat is older than 30 s; a heartbeat from a new socket of the
// same user resumes it (reconnect grace = heartbeat timeout).
//
// Moderation: the sweeper re-reads both participants every pass and ends a session when
// either account is restricted (suspended, banned, moderation-restricted, deletion
// requested) or one has blocked the other. No moderation code is changed.
//
// Safety eligibility (Phase 1, 19 Oct 2026): the same pass also ends a session when either
// participant no longer meets a SAFETY requirement Quick Connect is built on: photo
// verification no longer approved (photo changed, rejected, revoked), the 18+ check no longer
// passes (date of birth or adult confirmation changed), or no Quick Connect consent at all
// (withdrawn). The reason is 'moderation', so the other person learns nothing about why.
// Deliberately NOT ended mid-call: a new consent VERSION (it applies to the next search) and
// the optional beta allow-list (an operator control, not a safety rule). Ending releases both
// holds and the capacity slot like every other end, and later signaling, heartbeats and TURN
// requests for the session are refused, so a client cannot keep it alive.
//
// Single-instance assumption: one sweeper per process, with an overlap guard. Writes are
// conditional, so a second instance would duplicate work, not corrupt state.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const User = require('../../models/User');
const QuickConnectSession = require('../../models/QuickConnectSession');
const QuickConnectSearch = require('../../models/QuickConnectSearch');
const config = require('./config');
const sessions = require('./sessions');
const matching = require('./matching');
const notify = require('./notify');
const capacity = require('./capacity');
const waitlist = require('./waitlist');
const QuickConnectConsent = require('../../models/QuickConnectConsent');
const { evaluateEligibility, accountRestricted, ageFromDateOfBirth, ADULT_AGE } = require('./eligibility');
const discovery = () => require('./discovery');

const S = QuickConnectSession;
const isId = v => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.isValidObjectId(v);
const idx = (session, userId) => session.participants.map(String).indexOf(String(userId));
const peerOf = (session, userId) => session.participants.map(String).find(p => p !== String(userId));
const fail = code => ({ ok: false, code });

/** How long after a call ends a reconnecting phone is still told how it ended (qc_status lastEnded). */
const RECENT_END_MS = 2 * 60 * 1000;
/**
 * How a session ended, as `userId` should see it: the reason, whether the OTHER person ended it, the call length.
 * Sent with a SESSION_ENDED heartbeat answer and as qc_status lastEnded, so a phone that missed qc_session_ended
 * (it was reconnecting) still shows "They ended the call." instead of "The connection was lost."
 */
function endedView(s, userId) {
  const duration = s.connectedAt && s.endedAt ? Math.max(0, Math.floor((new Date(s.endedAt) - new Date(s.connectedAt)) / 1000)) : 0;
  return { sessionId: String(s._id), reason: s.endReason || 'disconnect_timeout', byPeer: !!s.endedBy && String(s.endedBy) !== String(userId), durationSeconds: duration };
}

/** Ends a session for `reason`, releases holds, and tells both participants. */
async function finishSession(sessionId, reason, { endedBy = null, onlyIf = null } = {}) {
  const r = await sessions.endSession(sessionId, reason, { endedBy, onlyIf });
  if (r.ended && r.session) {
    const s = r.session;
    const duration = s.connectedAt ? Math.max(0, Math.floor((new Date(s.endedAt) - new Date(s.connectedAt)) / 1000)) : 0;
    for (const p of s.participants.map(String)) {
      notify.toUser(p, 'qc_session_ended', {
        sessionId: String(s._id), reason, durationSeconds: duration,
        byPeer: !!endedBy && String(endedBy) !== p
      });
    }
  }
  return r;
}

async function participantSession(sessionId, userId, statuses) {
  if (!isId(sessionId)) return { error: 'INVALID_REQUEST' };
  const s = await S.findOne({ _id: sessionId, participants: userId }).lean();
  if (!s) return { error: 'SESSION_NOT_FOUND' };
  if (!statuses.includes(s.status)) return { error: S.ACTIVE_STATUSES.includes(s.status) ? 'INVALID_STATE' : 'SESSION_ENDED', session: s };
  return { session: s };
}

/** PROPOSED: the user agrees. The second agreement (by either) makes it ACCEPTED, exactly once. */
async function acceptMatch(userId, sessionId, { auth = null, now = Date.now() } = {}) {
  if (!config.isEnabled()) return fail('QUICK_CONNECT_DISABLED');
  const { session, error } = await participantSession(sessionId, userId, ['PROPOSED']);
  if (error) return fail(error);
  if (new Date(session.proposedAt).getTime() + S.PROPOSAL_TIMEOUT_MS <= now) {
    await finishSession(session._id, 'proposal_timeout', { onlyIf: { status: 'PROPOSED' } });
    return fail('PROPOSAL_EXPIRED');
  }
  const e = await evaluateEligibility(userId, { auth, ownSessionId: String(session._id), now });
  if (!e.eligible) {
    await finishSession(session._id, 'cancelled', { endedBy: userId });
    return fail(e.code);
  }
  const marked = await S.findOneAndUpdate(
    { _id: session._id, status: 'PROPOSED', participants: userId },
    { $addToSet: { acceptedBy: userId } },
    { new: true }
  ).lean();
  if (!marked) return fail('SESSION_ENDED');
  if (marked.acceptedBy.length < 2) {
    notify.toUser(peerOf(marked, userId), 'qc_peer_status', { sessionId: String(marked._id), state: 'accepted' });
    return { ok: true, state: 'waiting_for_peer' };
  }
  const t = new Date(now);
  const accepted = await S.findOneAndUpdate(
    { _id: session._id, status: 'PROPOSED', acceptedBy: { $all: marked.participants } },
    { $set: { status: 'ACCEPTED', acceptedAt: t, endsAt: new Date(now + S.MAX_DURATION_MS), lastSeenAt: [t, t] } },
    { new: true }
  ).lean();
  if (accepted) {
    accepted.participants.forEach((p, i) => notify.toUser(p, 'qc_session_accepted', {
      sessionId: String(accepted._id),
      role: i === 0 ? 'offerer' : 'answerer',        // participants are sorted; the first sends the offer
      endsAt: accepted.endsAt.toISOString(),
      heartbeatIntervalSeconds: 10
    }));
  }
  return { ok: true, state: 'accepted' };
}

async function declineMatch(userId, sessionId, { now = Date.now() } = {}) {
  const { session, error } = await participantSession(sessionId, userId, ['PROPOSED']);
  if (error) return error === 'SESSION_ENDED' ? { ok: true, alreadyEnded: true } : fail(error);
  // Skip: the two are not matched again for a while. Written BEFORE the session ends —
  // ending releases the holds, and only then can either of them search again — so every
  // later match attempt sees it. A failed write never blocks the decline itself.
  try {
    await matching.excludeSkippedPair(session.participants[0], session.participants[1], { now });
  } catch (err) {
    console.error('[quick-connect] skip exclusion write failed:', err && err.name);
  }
  await finishSession(session._id, 'declined', { endedBy: userId, onlyIf: { status: 'PROPOSED' } });
  return { ok: true };
}

/** ACCEPTED → CONNECTING (idempotent). Called on the first relayed offer, or by the client. */
async function markConnecting(userId, sessionId) {
  const { session, error } = await participantSession(sessionId, userId, S.MEDIA_STATUSES);
  if (error) return fail(error);
  await S.updateOne({ _id: session._id, status: 'ACCEPTED' }, { $set: { status: 'CONNECTING' } });
  return { ok: true };
}

/** ACCEPTED|CONNECTING → CONNECTED (idempotent). connectedAt is the server's time. */
async function markConnected(userId, sessionId, { now = Date.now() } = {}) {
  const { session, error } = await participantSession(sessionId, userId, S.MEDIA_STATUSES);
  if (error) return fail(error);
  const r = await S.updateOne({ _id: session._id, status: { $in: ['ACCEPTED', 'CONNECTING'] } },
    { $set: { status: 'CONNECTED', connectedAt: new Date(now) } });
  if (r.modifiedCount > 0) notify.toUser(peerOf(session, userId), 'qc_peer_status', { sessionId: String(session._id), state: 'connected' });
  return { ok: true, endsAt: new Date(session.endsAt).toISOString() };
}

/** Records the participant's heartbeat (server clock). Ended sessions answer SESSION_ENDED. */
async function heartbeat(userId, sessionId, { now = Date.now() } = {}) {
  if (!isId(sessionId)) return fail('INVALID_REQUEST');
  const s = await S.findOne({ _id: sessionId, participants: userId }).select('participants status endsAt endReason endedBy connectedAt endedAt').lean();
  if (!s) return fail('SESSION_NOT_FOUND');
  if (s.status === 'PROPOSED') return fail('INVALID_STATE');
  if (!S.MEDIA_STATUSES.includes(s.status)) return { ...fail('SESSION_ENDED'), ended: endedView(s, userId) };
  const i = idx(s, userId);
  const r = await S.updateOne({ _id: s._id, status: { $in: S.MEDIA_STATUSES } }, { $set: { [`lastSeenAt.${i}`]: new Date(now) } });
  if (r.matchedCount === 0) return fail('SESSION_ENDED');
  return { ok: true, endsAt: new Date(s.endsAt).toISOString(), serverTime: new Date(now).toISOString() };
}

async function hangup(userId, sessionId) {
  if (!isId(sessionId)) return fail('INVALID_REQUEST');
  const s = await S.findOne({ _id: sessionId, participants: userId }).select('_id status').lean();
  if (!s) return fail('SESSION_NOT_FOUND');
  const r = await finishSession(s._id, 'hangup', { endedBy: userId });
  return { ok: true, alreadyEnded: !r.ended };
}

/**
 * The user cancelled their search. A proposal created for them in the same moment (they have
 * not accepted it) is withdrawn too, so a cancelled search never turns into a match card.
 * The other person sees an ordinary skip and keeps searching. Open Smart Discovery
 * invitations of this search are cancelled.
 */
async function cancelSearchAndProposals(userId) {
  const r = await matching.cancelSearch(userId);
  const proposals = await S.find({ participants: userId, status: 'PROPOSED', acceptedBy: { $ne: userId } }).select('_id').lean();
  let withdrawn = 0;
  for (const p of proposals) {
    if ((await finishSession(p._id, 'declined', { endedBy: userId, onlyIf: { status: 'PROPOSED', acceptedBy: { $ne: userId } } })).ended) withdrawn++;
  }
  try { await discovery().cancelForInviter(userId); } catch (err) {
    console.error('[quick-connect] invite cancel failed:', err && err.name);
  }
  return { ...r, proposalsWithdrawn: withdrawn };
}

/** True when the user no longer meets a safety requirement of an open session (see header). */
function safetyIneligible(user, hasConsent, now) {
  if (user.photoVerificationStatus !== 'approved') return true;
  const q = user.questionnaire || {};
  const age = ageFromDateOfBirth(q.dateOfBirth, now);
  if (age === null || age < ADULT_AGE || q.isAdultConfirmed !== true) return true;
  return !hasConsent;
}

/** Ends every open session of a user (phone takeover, etc.) and removes their search. */
async function endSessionsForUser(userId, reason) {
  await QuickConnectSearch.deleteOne({ _id: userId });
  const open = await S.find({ participants: userId, status: { $in: S.ACTIVE_STATUSES } }).select('_id').lean();
  let ended = 0;
  for (const s of open) if ((await finishSession(s._id, reason)).ended) ended++;
  return ended;
}

/** The user's current Quick Connect state, for reconnects. */
async function currentState(userId, { now = Date.now() } = {}) {
  const s = await S.findOne({ participants: userId, status: { $in: S.ACTIVE_STATUSES } }).sort({ createdAt: -1 }).lean();
  if (s) {
    return {
      state: s.status.toLowerCase(), sessionId: String(s._id),
      role: idx(s, userId) === 0 ? 'offerer' : 'answerer',
      endsAt: S.MEDIA_STATUSES.includes(s.status) ? new Date(s.endsAt).toISOString() : null,
      youAccepted: (s.acceptedBy || []).map(String).includes(String(userId)),
      // Phase 2: a reconnecting phone that missed qc_match_proposed can still show the match card.
      ...(s.status === 'PROPOSED' ? await matching.proposalView(s, userId) : {})
    };
  }
  const search = await matching.searchOf(userId, now);
  if (search) return { state: 'searching', ...search };
  // A call that ended moments ago (its qc_session_ended may have been missed while reconnecting).
  const recent = await S.findOne({ participants: userId, status: { $in: S.TERMINAL_STATUSES }, endedAt: { $gte: new Date(now - RECENT_END_MS) } })
    .sort({ endedAt: -1 }).select('endReason endedBy connectedAt endedAt').lean();
  return recent ? { state: 'idle', lastEnded: endedView(recent, userId) } : { state: 'idle' };
}

// ── sweeper ───────────────────────────────────────────────────────────────────
async function endWhere(filter, reason, onlyIf, counters, key) {
  const rows = await S.find({ $and: [{ status: { $in: S.ACTIVE_STATUSES } }, filter] }).select('_id').limit(200).lean();
  for (const r of rows) if ((await finishSession(r._id, reason, { onlyIf })).ended) counters[key]++;
}

/** One sweep. Safe to run any time, any number of times. Returns counters. */
async function sweep({ now = Date.now() } = {}) {
  const c = { featureDisabled: 0, proposalTimeout: 0, setupTimeout: 0, maxDuration: 0, heartbeatTimeout: 0,
    moderation: 0, blocked: 0, ineligible: 0, stale: 0, searchesCleared: 0, searchesExpired: 0, pairingFreed: 0, matched: 0,
    slotsReconciled: 0, waitlistNotified: 0, waitlistRemoved: 0, waitlistExpired: 0, waitlistPushFailed: 0,
    invitesSent: 0, invitesExpired: 0, invitesCancelled: 0 };

  if (!config.isEnabled()) {
    const open = await S.find({ status: { $in: S.ACTIVE_STATUSES } }).select('_id').limit(500).lean();
    for (const s of open) if ((await finishSession(s._id, 'feature_disabled')).ended) c.featureDisabled++;
    c.searchesCleared = await matching.clearAllSearches('unavailable');
    c.slotsReconciled = await capacity.reconcile({ now });
    Object.assign(c, await waitlist.notifyTick({ now }));      // switched off: only expires old entries
    Object.assign(c, await discovery().tick({ now }));        // switched off: cancels open invitations
    return c;
  }

  const proposalCut = new Date(now - S.PROPOSAL_TIMEOUT_MS);
  const proposal = { status: 'PROPOSED', proposedAt: { $lte: proposalCut } };
  await endWhere(proposal, 'proposal_timeout', proposal, c, 'proposalTimeout');

  const setupCut = new Date(now - S.SETUP_STALE_MS);
  const setup = { status: { $in: ['ACCEPTED', 'CONNECTING'] }, acceptedAt: { $lte: setupCut } };
  await endWhere(setup, 'setup_timeout', setup, c, 'setupTimeout');

  const max = { status: { $in: S.MEDIA_STATUSES }, endsAt: { $lte: new Date(now) } };
  await endWhere(max, 'max_duration', max, c, 'maxDuration');

  const hbCut = new Date(now - S.HEARTBEAT_TIMEOUT_MS);
  const hb = { status: { $in: S.MEDIA_STATUSES }, lastSeenAt: { $elemMatch: { $lte: hbCut } } };
  await endWhere(hb, 'disconnect_timeout', hb, c, 'heartbeatTimeout');

  // Moderation, blocks and safety eligibility: re-read both participants of every open session.
  const open = await S.find({ status: { $in: S.ACTIVE_STATUSES } }).select('_id participants').limit(500).lean();
  if (open.length) {
    const userIds = [...new Set(open.flatMap(s => s.participants.map(String)))];
    const [users, consenting] = await Promise.all([
      User.find({ _id: { $in: userIds } })
        .select('status suspensionInfo banInfo moderationFlags.restrictedUntil deletionRequestedAt blockedUsers ' +
          'photoVerificationStatus questionnaire.dateOfBirth questionnaire.isAdultConfirmed').lean(),
      QuickConnectConsent.distinct('userId', { userId: { $in: userIds } })
    ]);
    const byId = new Map(users.map(u => [String(u._id), u]));
    const hasConsent = new Set(consenting.map(String));
    for (const s of open) {
      const [a, b] = s.participants.map(String);
      const ua = byId.get(a), ub = byId.get(b);
      if (!ua || !ub || accountRestricted(ua, now) || accountRestricted(ub, now)) {
        if ((await finishSession(s._id, 'moderation')).ended) c.moderation++;
      } else if ((ua.blockedUsers || []).map(String).includes(b) || (ub.blockedUsers || []).map(String).includes(a)) {
        if ((await finishSession(s._id, 'blocked')).ended) c.blocked++;
      } else if (safetyIneligible(ua, hasConsent.has(a), now) || safetyIneligible(ub, hasConsent.has(b), now)) {
        if ((await finishSession(s._id, 'moderation')).ended) c.ineligible++;
      }
    }
  }

  c.stale = await sessions.sweepStaleSessions({ now });   // Phase 4 catch-all
  c.slotsReconciled = await capacity.reconcile({ now });  // capacity left behind by a crash
  Object.assign(c, await matching.matchTick({ now }));
  Object.assign(c, await waitlist.notifyTick({ now }));   // "Notify me": only as many as free slots
  Object.assign(c, await discovery().tick({ now }));      // Smart Discovery invitations (no-op unless enabled)
  return c;
}

let timer = null;
let running = false;
let lastCounters = null;

async function sweepOnce() {
  if (running) return null;                                    // no overlapping runs
  if (mongoose.connection.readyState !== 1) return null;       // not connected (startup/shutdown)
  running = true;
  try {
    const c = await sweep();
    lastCounters = { at: new Date().toISOString(), ...c };
    const busy = Object.entries(c).filter(([, v]) => v > 0);
    if (busy.length) console.log('[quick-connect] sweep', busy.map(([k, v]) => `${k}=${v}`).join(' '));
    return c;
  } catch (err) {
    console.error('[quick-connect] sweep failed:', err && err.name);
    return null;
  } finally {
    running = false;
  }
}

function startSweeper() {
  if (timer) return;
  timer = setInterval(sweepOnce, config.sweepIntervalMs());
  if (timer.unref) timer.unref();
  process.once('SIGTERM', stopSweeper);
  process.once('SIGINT', stopSweeper);
}
function stopSweeper() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  acceptMatch, declineMatch, markConnecting, markConnected, heartbeat, hangup,
  finishSession, endSessionsForUser, cancelSearchAndProposals, currentState, sweep, sweepOnce, startSweeper, stopSweeper,
  _internal: { safetyIneligible },
  lastSweep: () => lastCounters
};
