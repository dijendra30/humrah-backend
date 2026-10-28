// services/movieChatLifetime.js
// -----------------------------------------------------------------------------
// Movie Hangout — how long a hangout's CHAT lives (Sports' rule, for movies).
//
//   chat expires at  max(lastMessageAt, showTime) + 7 days
//
// The showtime is a floor, not an end: a chat always lasts at least 7 days after
// the movie, and after that for as long as people keep talking, with no upper
// limit. 7 days without a member's message and it closes (read-only), then leaves
// everyone's Sessions list 7 days later (or sooner, if they delete it).
//
// The CARD is separate and unchanged: MovieSession.status turns 'expired' 15 min
// after the showtime, which only takes the hangout off Plans Near You and stops
// new joins. It no longer closes the chat.
//
// lastMessageAt moves only on QUALIFYING activity — a member's message (text or
// voice) or a join — and only forward. Reactions, edits, deletes, reads, system
// messages, the ticket check, leaves and list reads never move it.
//
// 'expired' is worked out on every read and send and written once (chatExpiredAt)
// the first time it is seen. A send "claims" activity with one conditional update
// that only matches a still-open chat; the expiry write is the complementary
// conditional update. MongoDB applies updates to one document one at a time, so
// exactly one wins a race at the boundary. No timers, no background job.
// -----------------------------------------------------------------------------
'use strict';

const MovieSession = require('../models/MovieSession');

const DAY_MS              = 24 * 60 * 60 * 1000;
const INACTIVITY_MS       = 7 * DAY_MS;   // no qualifying activity for this long → closed
const LIST_AFTER_CLOSE_MS = 7 * DAY_MS;   // a closed chat stays in Sessions this long

const ms = d => (d ? new Date(d).getTime() : 0);

/** When this hangout's chat closes (or closed). */
function chatExpiresAtOf(session) {
  return new Date(Math.max(ms(session.lastMessageAt), ms(session.showTime)) + INACTIVITY_MS);
}

/** 'active' | 'expired' — server state and server time only. */
function chatStateOf(session, now = Date.now()) {
  if (session && session.chatExpiredAt) return 'expired';
  return now >= chatExpiresAtOf(session).getTime() ? 'expired' : 'active';
}

/** The moment it closed, for a closed chat; null while it is open. */
function chatClosedAt(session, now = Date.now()) {
  if (session.chatExpiredAt) return new Date(session.chatExpiredAt);
  return chatStateOf(session, now) === 'expired' ? chatExpiresAtOf(session) : null;
}

/** Writes the expiry once, the first time it is seen (conditional: never over new activity). */
async function persistExpiryIfDue(session, now = Date.now()) {
  if (!session || session.chatExpiredAt) return session;
  const expiredAt = chatExpiresAtOf(session);
  if (now < expiredAt.getTime()) return session;
  const cutoff = new Date(now - INACTIVITY_MS);
  const res = await MovieSession.updateOne(
    {
      _id: session._id,
      chatExpiredAt: null,
      showTime: { $lte: cutoff },
      $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: cutoff } }],
    },
    { $set: { chatExpiredAt: expiredAt } },
  );
  if (res.modifiedCount === 1) {
    session.chatExpiredAt = expiredAt;
    console.log(`[MOVIE_CHAT_EXPIRED] session=${session._id} expiredAt=${expiredAt.toISOString()}`);
  }
  return session;
}

/**
 * A member's message (or a join): move lastMessageAt forward — only while the chat is
 * still open. Returns false when it has closed (the caller then refuses the send).
 */
async function claimActivity(sessionId, now = Date.now()) {
  const cutoff = new Date(now - INACTIVITY_MS);
  const res = await MovieSession.updateOne(
    {
      _id: sessionId,
      chatExpiredAt: null,
      $or: [{ showTime: { $gt: cutoff } }, { lastMessageAt: { $gt: cutoff } }],
    },
    { $max: { lastMessageAt: new Date(now) } },
  );
  return res.matchedCount === 1;
}

/**
 * What a long press on the Sessions card offers this member: LEAVE while the chat is
 * open, DELETE (from their own list) once it has closed.
 */
function removalOf(session, now = Date.now()) {
  return chatStateOf(session, now) === 'expired' ? 'DELETE' : 'LEAVE';
}

/** Until when a closed chat is listed (null while open). */
function listedUntil(session, now = Date.now()) {
  const closed = chatClosedAt(session, now);
  return closed ? new Date(closed.getTime() + LIST_AFTER_CLOSE_MS) : null;
}

/** Hidden from this member's list by their own "Delete", unless the chat has had activity since. */
function hiddenFromList(row, session) {
  if (!row || !row.hiddenAt) return false;
  return ms(session.lastMessageAt) <= ms(row.hiddenAt);
}

module.exports = {
  chatExpiresAtOf, chatStateOf, chatClosedAt, persistExpiryIfDue, claimActivity,
  removalOf, listedUntil, hiddenFromList,
  INACTIVITY_MS, LIST_AFTER_CLOSE_MS,
};
