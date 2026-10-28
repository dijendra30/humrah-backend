// services/movieMembershipService.js
// -----------------------------------------------------------------------------
// Movie Hangout — Leave Hangout, and the leaver's own Sessions list.
//
// MEMBERSHIP. A member is someone in MovieSession.participants — the list every
// message, reaction, pin, read, chat load and socket room already checks. Leaving
// removes the caller (and only the caller) from it in one conditional update, so
// from that moment every one of those paths refuses them, whatever client they
// use. The session, its messages and everyone else are untouched; nothing is
// deleted. The leave is recorded on the caller's own MovieParticipant row (leftAt).
//
// THE 5-MINUTE RULE. The leaver's Sessions list keeps the hangout for exactly
// LIST_GRACE_MS after the server's leave timestamp, marked as left, then never
// shows it again. That is decided from the stored leftAt every time the list is
// read (getMySessions) — not by a timer — so it holds across app closes, server
// restarts and deploys, needs no job that could be lost or run twice, and only
// ever concerns that one person. Rejoining sets leftAt back to null, so an old
// leave can never hide a rejoined hangout.
// -----------------------------------------------------------------------------
'use strict';

const mongoose         = require('mongoose');
const MovieSession     = require('../models/MovieSession');
const MovieChat        = require('../models/MovieChat');
const MovieParticipant = require('../models/MovieParticipant');

const LIST_GRACE_MS = 5 * 60 * 1000;

const fail = (status, code, message) => ({ success: false, status, code, message });
const iso = d => new Date(d).toISOString();

/** When a leave stops showing in the leaver's own Sessions list. */
const listRemoveAt = leftAt => new Date(new Date(leftAt).getTime() + LIST_GRACE_MS);

/**
 * POST /movie-session/:id/leave — the caller leaves; nobody can leave for anyone else
 * (the user comes only from the token). Leaving twice is fine: the second time says
 * so and changes nothing.
 */
async function leaveSession(userId, sessionId, io, now = Date.now()) {
  if (!mongoose.isValidObjectId(sessionId)) return fail(404, 'SESSION_NOT_FOUND', 'Session not found');
  const uid = new mongoose.Types.ObjectId(String(userId));

  // The one step that decides it: only a current member is removed, exactly once.
  const updated = await MovieSession.findOneAndUpdate(
    { _id: sessionId, participants: uid },
    { $pull: { participants: uid } },
    { new: true },
  );
  if (!updated) {
    const exists = await MovieSession.exists({ _id: sessionId });
    if (!exists) return fail(404, 'SESSION_NOT_FOUND', 'Session not found');
    const row = await MovieParticipant.findOne({ sessionId, userId: uid }).select('leftAt').lean();
    if (row && row.leftAt) {
      return { success: true, status: 200, alreadyLeft: true, sessionId: String(sessionId),
        leftAt: iso(row.leftAt), listRemoveAt: iso(listRemoveAt(row.leftAt)) };
    }
    return fail(403, 'NOT_A_MEMBER', 'You are not a member of this hangout');
  }

  const leftAt = new Date(now);
  // Their own row only. Upsert: older members may never have had one.
  await MovieParticipant.updateOne(
    { sessionId: updated._id, userId: uid },
    { $set: { leftAt }, $setOnInsert: { joinedAt: leftAt } },
    { upsert: true },
  );
  // The admin role moves to the next member (or none) — never left with someone outside.
  await MovieSession.updateOne(
    { _id: updated._id, adminId: uid },
    { $set: { adminId: updated.participants[0] || null } },
  );
  // The legacy MovieChat copy of the member list, kept in step.
  if (updated.chatId) {
    await MovieChat.updateOne({ _id: updated.chatId }, { $pull: { participants: uid } }).catch(() => {});
  }

  // "Asha left the hangout" for the people still in it. Never fails the leave.
  try {
    const User = mongoose.model('User');
    const u = await User.findById(uid).select('firstName').lean();
    const name = (u && u.firstName && String(u.firstName).trim()) || 'Someone';
    await require('./movieHangoutService').postSystemMessage(updated._id, `${name} left the hangout`, io);
  } catch (e) {
    console.warn('[movieLeave] system message not posted:', e.message);
  }

  if (io) {
    try {
      const room = `movie:${updated._id}`;
      io.to(room).emit('movieParticipantLeft', {
        sessionId: String(updated._id), userId: String(uid), participantsCount: updated.participants.length,
      });
      // Their open chat screens stop receiving this room at once (the room's join is
      // membership-checked, so they cannot listen again either).
      io.in(`user:${uid}`).socketsLeave(room);
      io.to(`user:${uid}`).emit('movieSessionLeft', {
        sessionId: String(updated._id), leftAt: iso(leftAt), listRemoveAt: iso(listRemoveAt(leftAt)),
      });
    } catch (e) {
      console.warn('[movieLeave] socket update failed:', e.message);
    }
  }
  console.log(`[MOVIE_LEAVE] session=${updated._id} user=${uid} remaining=${updated.participants.length}`);

  return { success: true, status: 200, sessionId: String(updated._id),
    leftAt: iso(leftAt), listRemoveAt: iso(listRemoveAt(leftAt)) };
}

/** Joining (or rejoining): this person is in it again — no leave may hide it. */
async function clearLeave(userId, sessionId) {
  await MovieParticipant.updateOne(
    { sessionId, userId },
    { $set: { leftAt: null } },
  );
}

/**
 * The hangouts this person left within the last LIST_GRACE_MS and is not back in:
 * { sessionId → leftAt }. Older leaves are simply not returned.
 */
async function recentLeaves(userId, now = Date.now()) {
  const rows = await MovieParticipant.find({
    userId,
    leftAt: { $ne: null, $gt: new Date(now - LIST_GRACE_MS) },
  }).select('sessionId leftAt').lean();
  return new Map(rows.map(r => [String(r.sessionId), r.leftAt]));
}

module.exports = { leaveSession, clearLeave, recentLeaves, listRemoveAt, LIST_GRACE_MS };
