// sockets/quickConnectSocket.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 5) — matching, signaling and call lifecycle on a DEDICATED
// namespace. Touches no other namespace.
//
//   namespace  /quick-connect
//   user room  qcu:{userId}   joined by the SERVER on connect; clients can join nothing
//
// Authentication is the existing one: JWT + utils/sessionGuard (tokenVersion and the
// single-phone session), then the account must be ACTIVE and not suspended/banned —
// the same decisions sockets/sportsSocket.js makes. While QUICK_CONNECT_ENABLED is off
// new connections are refused and new activity is refused; hangup, decline, cancel and
// status keep working so nothing is stranded (the sweeper also ends open sessions).
//
// client → server (every event answers through its ack: { ok: true, ... } | { ok: false, code })
//   qc_search_start   {}                          start searching (eligibility re-checked)
//   qc_search_cancel  {}                          stop searching
//   qc_status         {}                          my current state (for reconnects)
//   qc_match_accept   { sessionId }               PROPOSED: I agree
//   qc_match_decline  { sessionId }               PROPOSED: I decline
//   qc_call_connecting{ sessionId }               media setup started (optional)
//   qc_call_connected { sessionId }               ICE connected
//   qc_heartbeat      { sessionId }               every ~10 s while accepted/connecting/connected
//   qc_offer          { sessionId, sdp: { type:'offer',  sdp } }   offerer only
//   qc_answer         { sessionId, sdp: { type:'answer', sdp } }   answerer only
//   qc_ice_candidate  { sessionId, candidate: { candidate, sdpMid, sdpMLineIndex } }
//   qc_hangup         { sessionId }
// server → client
//   qc_search_ended   { reason: timeout | busy | not_eligible | unavailable }
//   qc_match_proposed { sessionId, expiresAt, matchType, sharedInterests[], peer: { firstName, profilePhoto } }
//   qc_session_accepted { sessionId, role: offerer|answerer, endsAt, heartbeatIntervalSeconds }
//   qc_peer_status    { sessionId, state: accepted | connected | disconnected | online }
//   qc_offer / qc_answer / qc_ice_candidate   the other participant's signaling, { sessionId, sdp|candidate }
//   qc_session_ended  { sessionId, reason, durationSeconds, byPeer }
//
// Signaling: the relay target is ALWAYS the session's other participant, read from the
// database; the session must be ACCEPTED/CONNECTING/CONNECTED, not past endsAt, and the
// sender a participant (offer = offerer, answer = answerer). Only validated fields are
// forwarded; SDP and ICE are never logged. Media never passes through the server.
// Payload limits: SDP ≤ 16 KB, candidate ≤ 1 KB. Per-socket rate limits below.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const QuickConnectSession = require('../models/QuickConnectSession');
const { verifySocketSession, tagSocket } = require('../utils/sessionGuard');
const config = require('../services/quickConnect/config');
const notify = require('../services/quickConnect/notify');
const matching = require('../services/quickConnect/matching');
const lifecycle = require('../services/quickConnect/lifecycle');
const { accountRestricted } = require('../services/quickConnect/eligibility');

const NAMESPACE = '/quick-connect';
const MAX_SDP = 16 * 1024;
const MAX_CANDIDATE = 1024;
const MAX_MID = 64;

// events per window, per socket
const LIMITS = {
  qc_search_start: [6, 60e3], qc_search_cancel: [20, 60e3], qc_status: [30, 60e3],
  qc_match_accept: [10, 60e3], qc_match_decline: [10, 60e3],
  qc_call_connecting: [10, 60e3], qc_call_connected: [10, 60e3], qc_heartbeat: [12, 60e3],
  qc_offer: [10, 60e3], qc_answer: [10, 60e3], qc_ice_candidate: [120, 60e3], qc_hangup: [10, 60e3]
};
// still allowed while switched off: they only end or inspect things
const CLEANUP_EVENTS = new Set(['qc_search_cancel', 'qc_status', 'qc_match_decline', 'qc_hangup']);

// `${userId}|${sessionId}` of participants whose last socket dropped during a live call; their
// next heartbeat tells the peer they are back. Lost on restart (only a notification is lost).
const awaitingReturn = new Set();

const isId = v => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.isValidObjectId(v);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function allow(socket, event) {
  const [max, windowMs] = LIMITS[event];
  const now = Date.now();
  const buckets = socket.data.rate || (socket.data.rate = {});
  const b = buckets[event] && now - buckets[event].start < windowMs ? buckets[event] : (buckets[event] = { start: now, n: 0 });
  b.n++;
  return b.n <= max;
}

async function authenticate(socket, next) {
  try {
    const raw = socket.handshake && socket.handshake.auth ? socket.handshake.auth.token : null;
    const { decoded, user } = await verifySocketSession(raw, User, 'status suspensionInfo banInfo moderationFlags.restrictedUntil deletionRequestedAt');
    if (decoded.scope) return next(new Error('Authentication error: Not allowed'));          // dashboard tokens
    if (accountRestricted(user, Date.now())) return next(new Error('Authentication error: Account not active'));
    if (!config.isEnabled()) return next(new Error('Quick Connect is not available'));
    tagSocket(socket, decoded);
    socket.data.userId = String(user._id);
    return next();
  } catch (err) {
    const msg = err && err.message ? err.message : '';
    return next(new Error(msg.startsWith('Authentication error') ? msg : 'Authentication error'));
  }
}

/** Validated signaling payload, or null. Returns only the fields that may be forwarded. */
function cleanSdp(p, type) {
  if (!isObj(p) || !isObj(p.sdp)) return null;
  const { sdp } = p;
  if (sdp.type !== type || typeof sdp.sdp !== 'string' || sdp.sdp.length === 0 || sdp.sdp.length > MAX_SDP) return null;
  return { type, sdp: sdp.sdp };
}
function cleanCandidate(p) {
  if (!isObj(p) || !isObj(p.candidate)) return null;
  const c = p.candidate;
  if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return null;
  if (!(c.sdpMid === null || c.sdpMid === undefined || (typeof c.sdpMid === 'string' && c.sdpMid.length <= MAX_MID))) return null;
  if (!(c.sdpMLineIndex === null || c.sdpMLineIndex === undefined || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 64))) return null;
  return { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
}

/** The live media session `sessionId` of `userId`, with their position, or an error code. */
async function signalingSession(userId, sessionId) {
  if (!isId(sessionId)) return { error: 'INVALID_REQUEST' };
  const s = await QuickConnectSession.findOne({ _id: sessionId, participants: userId }).select('participants status endsAt').lean();
  if (!s) return { error: 'SESSION_NOT_FOUND' };
  if (!QuickConnectSession.MEDIA_STATUSES.includes(s.status) || new Date(s.endsAt).getTime() <= Date.now()) return { error: 'SESSION_ENDED' };
  const me = s.participants.map(String).indexOf(String(userId));
  return { session: s, me, peer: String(s.participants[1 - me]) };
}

async function relay(socket, event, payload) {
  const userId = socket.data.userId;
  const clean = event === 'qc_ice_candidate' ? cleanCandidate(payload) : cleanSdp(payload, event === 'qc_offer' ? 'offer' : 'answer');
  if (!clean || !isId(payload && payload.sessionId)) return { ok: false, code: 'INVALID_REQUEST' };
  const { session, me, peer, error } = await signalingSession(userId, payload.sessionId);
  if (error) return { ok: false, code: error };
  if (event === 'qc_offer' && me !== 0) return { ok: false, code: 'NOT_ALLOWED' };
  if (event === 'qc_answer' && me !== 1) return { ok: false, code: 'NOT_ALLOWED' };
  const out = { sessionId: String(session._id) };
  if (event === 'qc_ice_candidate') out.candidate = clean; else out.sdp = clean;
  notify.toUser(peer, event, out);
  if (event === 'qc_offer') await QuickConnectSession.updateOne({ _id: session._id, status: 'ACCEPTED' }, { $set: { status: 'CONNECTING' } });
  return { ok: true };
}

const HANDLERS = {
  qc_search_start: (s) => matching.startSearch(s.data.userId, { auth: { scope: s.data.scope } }),
  qc_search_cancel: (s) => matching.cancelSearch(s.data.userId),
  qc_status: async (s) => ({ ok: true, enabled: config.isEnabled(), ...(await lifecycle.currentState(s.data.userId)) }),
  qc_match_accept: (s, p) => lifecycle.acceptMatch(s.data.userId, p && p.sessionId, { auth: { scope: s.data.scope } }),
  qc_match_decline: (s, p) => lifecycle.declineMatch(s.data.userId, p && p.sessionId),
  qc_call_connecting: (s, p) => lifecycle.markConnecting(s.data.userId, p && p.sessionId),
  qc_call_connected: (s, p) => lifecycle.markConnected(s.data.userId, p && p.sessionId),
  qc_heartbeat: async (s, p) => {
    const r = await lifecycle.heartbeat(s.data.userId, p && p.sessionId);
    const key = `${s.data.userId}|${p && p.sessionId}`;
    if (r.ok && awaitingReturn.delete(key)) {                    // back after a dropped connection
      const sess = await QuickConnectSession.findById(p.sessionId).select('participants').lean();
      if (sess) notify.toUser(sess.participants.map(String).find(x => x !== s.data.userId), 'qc_peer_status', { sessionId: p.sessionId, state: 'online' });
    }
    return r;
  },
  qc_offer: (s, p) => relay(s, 'qc_offer', p),
  qc_answer: (s, p) => relay(s, 'qc_answer', p),
  qc_ice_candidate: (s, p) => relay(s, 'qc_ice_candidate', p),
  qc_hangup: (s, p) => lifecycle.hangup(s.data.userId, p && p.sessionId)
};

function onConnection(socket) {
  const userId = socket.data.userId;
  socket.join(notify.userRoom(userId));

  for (const event of Object.keys(HANDLERS)) {
    socket.on(event, async (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = undefined; }
      const reply = r => { if (typeof ack === 'function') ack(r); };
      try {
        if (!allow(socket, event)) return reply({ ok: false, code: 'RATE_LIMITED' });
        if (payload !== undefined && payload !== null && !isObj(payload)) return reply({ ok: false, code: 'INVALID_REQUEST' });
        if (!config.isEnabled() && !CLEANUP_EVENTS.has(event)) return reply({ ok: false, code: 'QUICK_CONNECT_DISABLED' });
        return reply(await HANDLERS[event](socket, payload || {}));
      } catch (err) {
        console.error(`[quick-connect] ${event} failed:`, err && err.name);   // never the payload
        return reply({ ok: false, code: 'SERVER_ERROR' });
      }
    });
  }

  socket.on('disconnect', async () => {
    try {
      if (await notify.socketCount(userId) > 0) return;          // another socket of this user is still here
      await matching.cancelSearch(userId);                       // searching needs a live connection
      const open = await QuickConnectSession.find({ participants: userId, status: { $in: QuickConnectSession.MEDIA_STATUSES } })
        .select('participants').lean();
      for (const s of open) {                                    // the call is NOT ended: reconnect grace
        awaitingReturn.add(`${userId}|${String(s._id)}`);
        notify.toUser(s.participants.map(String).find(x => x !== userId), 'qc_peer_status', { sessionId: String(s._id), state: 'disconnected' });
      }
    } catch (err) {
      console.error('[quick-connect] disconnect cleanup failed:', err && err.name);
    }
  });
}

function initQuickConnectSocket(io) {
  const nsp = io.of(NAMESPACE);
  nsp.use(authenticate);
  nsp.on('connection', onConnection);
  notify.setNamespace(nsp);
  lifecycle.startSweeper();
  return nsp;
}

module.exports = { initQuickConnectSocket, NAMESPACE, _internal: { cleanSdp, cleanCandidate, LIMITS } };
