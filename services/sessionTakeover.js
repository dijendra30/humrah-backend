// services/sessionTakeover.js
// One signed-in phone per account. A successful app login makes that phone the account's
// only session; whatever the previous phone was doing is wound down here.
'use strict';

const crypto    = require('crypto');
const User      = require('../models/User');
const VoiceCall = require('../models/VoiceCall');
const admin     = require('../config/firebase');
const { DASHBOARD_SCOPE } = require('../utils/sessionGuard');

const ACTIVE_CALL_STATUSES = ['RINGING', 'CONNECTING', 'CONNECTED'];

/**
 * Makes this login the account's only signed-in phone and returns its session id.
 * Atomic: of two simultaneous logins the later write wins, and the other token is
 * rejected on its first use. The old phone's FCM tokens are dropped so it stops
 * receiving pushes and incoming calls; the new phone registers its own right after login.
 */
async function startAppSession(userId) {
  const sid = crypto.randomUUID();
  await User.updateOne(
    { _id: userId },
    { $set: { activeSessionId: sid, activeSessionStartedAt: new Date(), fcmTokens: [], fcmDevices: [] } }
  );
  return sid;
}

/** Ends the session this token belongs to, if it is still the current one. */
async function endAppSession(io, userId, sid) {
  if (!sid) return false;
  const res = await User.updateOne(
    { _id: userId, activeSessionId: sid },
    { $set: { activeSessionId: null, fcmTokens: [], fcmDevices: [] } }
  );
  if (res.modifiedCount > 0 && io) await disconnectStaleSockets(io, userId);
  return res.modifiedCount > 0;
}

/**
 * Winds down the previous phone after a takeover:
 *  1. ends every active call of the account (its phone just changed) and tells the
 *     other participant through the existing voice-call-ended socket event + CALL_ENDED push;
 *     the old phone gets the same socket event so it leaves the Agora channel;
 *  2. disconnects every socket that is not the current session.
 * Never touches other users' calls or the current session's sockets.
 */
async function retireOldSessions(io, userId) {
  const result = { callsEnded: 0, socketsDisconnected: 0 };
  const uid = String(userId);

  const calls = await VoiceCall.find({
    $or: [{ callerId: userId }, { receiverId: userId }],
    status: { $in: ACTIVE_CALL_STATUSES }
  }).select('_id status callerId receiverId connectedAt').lean();

  for (const call of calls) {
    const now      = new Date();
    const duration = call.connectedAt ? Math.floor((now - new Date(call.connectedAt)) / 1000) : null;
    // Only if the call is still in the state just read — never overwrite a newer one.
    const upd = await VoiceCall.updateOne(
      { _id: call._id, status: call.status },
      { $set: { status: 'ENDED', endedAt: now, endReason: 'session_replaced', duration } }
    );
    if (!upd.modifiedCount) continue;
    result.callsEnded++;

    const callId  = String(call._id);
    const otherId = String(call.callerId) === uid ? String(call.receiverId) : String(call.callerId);
    const payload = { callId, reason: 'session_replaced', duration: duration || 0 };
    if (io) {
      io.to('user:' + otherId).emit('voice-call-ended', payload);
      io.to('user:' + uid).emit('voice-call-ended', payload);   // the old phone, before it is disconnected
    }
    await sendCallEndedPush(otherId, payload);
  }

  if (io) result.socketsDisconnected = await disconnectStaleSockets(io, userId);
  return result;
}

/** Disconnects this user's sockets that do not belong to the current session (all namespaces). */
async function disconnectStaleSockets(io, userId) {
  const uid   = String(userId);
  const fresh = await User.findById(userId).select('+activeSessionId').lean();
  const current = fresh ? fresh.activeSessionId : null;

  const namespaces = io._nsps ? Array.from(io._nsps.values()) : [io.of('/')];
  let disconnected = 0;
  for (const ns of namespaces) {
    const sockets = await ns.fetchSockets();
    for (const s of sockets) {
      const d = s.data || {};
      if (d.authUserId !== uid) continue;
      if (d.scope === DASHBOARD_SCOPE) continue;
      if (current && d.sid === current) continue;
      s.emit('session-replaced', { code: 'SESSION_REPLACED' });
      s.disconnect(true);
      disconnected++;
    }
  }
  return disconnected;
}

async function sendCallEndedPush(userId, payload) {
  try {
    const user = await User.findById(userId).select('fcmTokens').lean();
    const tokens = (user && user.fcmTokens) || [];
    if (tokens.length === 0) return;
    await admin.messaging().sendEachForMulticast({
      tokens,
      android: { priority: 'high' },
      data: { type: 'CALL_ENDED', callId: payload.callId, reason: payload.reason, duration: String(payload.duration) }
    });
  } catch (err) {
    console.error('[SESSION] CALL_ENDED push failed:', err.message);
  }
}

module.exports = { startAppSession, endAppSession, retireOldSessions, disconnectStaleSockets };
