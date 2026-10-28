// services/movieTicketPollService.js
// -----------------------------------------------------------------------------
// Movie Hangout — the ticket check ("Have you booked your movie ticket? 🎬").
//
//   showTime − 1 h   the chat gets the poll and eligible members are notified
//                    ("Movie meetup in 1 hour 🎬").
//   until showTime   members answer: Yes, ticket booked / Not yet / Can't make it,
//                    and may change it. Counts update live.
//   showTime         the poll closes.
//
// Answers are self-reported. Nothing here checks, books or verifies a ticket, and a
// missing answer is never counted as a booked ticket.
//
// SCHEDULING — the Sports attendance check's machinery (sportsAttendanceService):
// one every-minute node-cron tick from cronJobs.js, all state in MongoDB, so it
// survives restarts and deploys and a missed minute is caught on the next one.
//   open   sessions whose showTime is in (now, now + 1 h] — so one created later
//          than an hour before its showtime opens on the next tick, and one that has
//          started or ended never gets a late poll. Still 'active' (not expired).
//   close  open polls whose closesAt (the showtime) has passed.
// Sessions cannot be rescheduled today; if a showTime ever changes while a poll is
// open, the poll follows the new time and keeps every answer (no second notice).
//
// NO ELIGIBLE PEOPLE → NOTHING. Eligible = current members (MovieSession.participants:
// people who left are not in it) whose account is active and not suspended. If there
// are none when the poll is due, no poll document, no chat message and no notification
// is created. The check is made before anything is written.
//
// IDEMPOTENCY. One MovieTicketPoll per session (unique sessionId = the key
// "MOVIE_TICKET_POLL:<sessionId>"); its chat message has a unique systemKey; the
// notification is claimed (openClaimedAt) before anything is sent. A tick run twice,
// late, or on two servers cannot open, post or notify twice.
// -----------------------------------------------------------------------------
'use strict';

const mongoose        = require('mongoose');
const MovieSession    = require('../models/MovieSession');
const MovieMessage    = require('../models/MovieMessage');
const MovieTicketPoll = require('../models/MovieTicketPoll');

const { ObjectId } = mongoose.Types;

const MIN = 60 * 1000;
const LEAD_MS            = 60 * MIN;
const MAX_OPEN_PER_TICK  = 200;
const MAX_CLOSE_PER_TICK = 200;

// ── The exact words ──────────────────────────────────────────────────────────
const TEXT = {
  question: 'Have you booked your movie ticket? 🎬',
  subtitle: 'The hangout starts in about 1 hour. Confirm your plans so everyone can coordinate.',
  options: [
    { key: 'BOOKED',       label: 'Yes, ticket booked' },
    { key: 'NOT_YET',      label: 'Not yet' },
    { key: 'CANT_MAKE_IT', label: "Can't make it" },
  ],
  pushTitle: 'Movie meetup in 1 hour 🎬',
  pushBody:  'Have you booked your ticket? Confirm your plans in the Humrah hangout.',
};

/**
 * A poll that could only open late (the hangout was created, or first joined, with
 * well under an hour to go) says how long is really left instead of "about 1 hour".
 */
function leadWords(minutesLeft) {
  if (minutesLeft >= 45) return null;                          // "about 1 hour" is true
  const m = Math.max(1, Math.round(minutesLeft / 5) * 5 || 1);
  return `${m} minutes`;
}
function subtitleFor(poll) {
  const left = Math.round((new Date(poll.closesAt) - new Date(poll.openedAt)) / MIN);
  const words = leadWords(left);
  return words ? `The hangout starts in about ${words}. Confirm your plans so everyone can coordinate.` : TEXT.subtitle;
}
function pushTitleFor(poll) {
  const left = Math.round((new Date(poll.closesAt) - new Date(poll.openedAt)) / MIN);
  const words = leadWords(left);
  return words ? `Movie meetup in ${words} 🎬` : TEXT.pushTitle;
}

const pollKey = sessionId => `MOVIE_TICKET_POLL:${sessionId}`;
const fail = (status, code, message) => ({ success: false, status, code, message });
const ids = arr => (arr || []).map(String);

/** The live Socket.IO server, read when needed (cronJobs.js runs inside server.js). */
function liveIo() {
  try { return require('../server').io || null; } catch (_) { return null; }
}

/**
 * Who may take part now: current members whose account is active and not suspended.
 * People who left are not in participants, so they are never here.
 */
async function eligibleMembers(session) {
  const memberIds = ids(session.participants);
  if (memberIds.length === 0) return [];
  const User = mongoose.model('User');
  const users = await User.find({ _id: { $in: memberIds } }).select('_id status suspensionInfo').lean();
  return users
    .filter(u => (!u.status || u.status === 'ACTIVE') && !(u.suspensionInfo && u.suspensionInfo.isSuspended === true))
    .map(u => String(u._id));
}

/** Counts from the people who are still members. Unanswered is its own number. */
function tally(poll, memberIds) {
  const members = new Set(ids(memberIds));
  const counts = { BOOKED: 0, NOT_YET: 0, CANT_MAKE_IT: 0 };
  let answered = 0;
  for (const r of poll.responses || []) {
    if (!members.has(String(r.userId))) continue;
    if (counts[r.answer] === undefined) continue;
    counts[r.answer] += 1;
    answered += 1;
  }
  return {
    booked:     counts.BOOKED,
    notYet:     counts.NOT_YET,
    cantMakeIt: counts.CANT_MAKE_IT,
    unanswered: Math.max(0, members.size - answered),
    members:    members.size,
  };
}

/** The poll as one viewer sees it: the counts, and only their own answer. */
function formatPoll(poll, memberIds, viewerId, now = Date.now()) {
  if (!poll) return null;
  const mine = viewerId ? (poll.responses || []).find(r => String(r.userId) === String(viewerId)) : null;
  const open = poll.status === 'OPEN' && now < new Date(poll.closesAt).getTime();
  return {
    id:        String(poll._id),
    sessionId: String(poll.sessionId),
    status:    open ? 'OPEN' : 'CLOSED',
    openedAt:  new Date(poll.openedAt).toISOString(),
    closesAt:  new Date(poll.closesAt).toISOString(),
    question:  TEXT.question,
    subtitle:  subtitleFor(poll),
    options:   TEXT.options,
    counts:    tally(poll, memberIds),
    myAnswer:  mine ? mine.answer : null,
  };
}

/** Everyone in the room gets the new counts; nobody is told who answered what. */
function broadcast(io, poll, memberIds) {
  if (!io || !poll) return;
  const p = formatPoll(poll, memberIds, null);
  io.to(`movie:${poll.sessionId}`).emit('movieTicketPoll', { ...p, myAnswer: undefined });
}

// ── Opening ───────────────────────────────────────────────────────────────────

async function postPollMessage(poll, session, io) {
  if (poll.pollMessageId) return;
  let msg = null;
  try {
    msg = await MovieMessage.create({
      sessionId:  session._id,
      senderId:   null,
      senderName: 'Humrah',
      type:       'system',
      // Older apps show this text as a system note; newer ones draw the poll card.
      text:       `${TEXT.question}\n${subtitleFor(poll)}`,
      pollId:     poll._id,
      systemKey:  pollKey(session._id),
    });
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;     // another tick posted it
    msg = await MovieMessage.findOne({ sessionId: session._id, systemKey: pollKey(session._id) });
  }
  if (!msg) return;
  await MovieTicketPoll.updateOne({ _id: poll._id, pollMessageId: null }, { $set: { pollMessageId: msg._id } });
  if (io) {
    const { formatMovieMessage } = require('./movieHangoutService');
    io.to(`movie:${session._id}`).emit('movieMessageReceived', formatMovieMessage(msg));
    broadcast(io, poll, session.participants);
  }
}

/**
 * The opening notification, at most once per poll: claimed before sending, then to
 * each eligible person who is still a member, with notifications on and a device.
 * "sent" counts what FCM accepted — not what reached a phone.
 */
async function notifyOpen(poll, session) {
  if (poll.notifications && poll.notifications.openClaimedAt) return 0;
  const claimed = await MovieTicketPoll.findOneAndUpdate(
    { _id: poll._id, 'notifications.openClaimedAt': null },
    { $set: { 'notifications.openClaimedAt': new Date(), 'notifications.key': pollKey(session._id) } },
    { new: true },
  ).lean();
  if (!claimed) return 0;

  const summary = { event: 'movie_ticket_poll', sessionId: String(session._id), considered: 0, sent: 0, skipped: {} };
  const skip = r => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; };
  try {
    const members = new Set(ids(session.participants));
    const recipients = [...new Set(ids(claimed.eligibleAtOpen))];
    summary.considered = recipients.length;
    if (recipients.length) {
      const User = mongoose.model('User');
      const users = await User.find({ _id: { $in: recipients } })
        .select('_id status suspensionInfo notifications fcmDevices fcmTokens').lean();
      const byId = new Map(users.map(u => [String(u._id), u]));
      const { sendDataFcm } = require('../utils/fcmHelper');
      for (const uid of recipients) {
        const u = byId.get(uid);
        if (!members.has(uid)) { skip('not_a_member'); continue; }
        if (!u) { skip('user_missing'); continue; }
        if (u.status && u.status !== 'ACTIVE') { skip('not_active'); continue; }
        if (u.suspensionInfo && u.suspensionInfo.isSuspended === true) { skip('suspended'); continue; }
        const prefs = u.notifications || {};
        if (prefs.pushNotifications === false || prefs.movieHangout === false) { skip('push_disabled'); continue; }
        const tokens = [...new Set([
          ...(u.fcmDevices || []).map(d => d && d.token),
          ...(u.fcmTokens || []),
        ].filter(t => typeof t === 'string' && t.trim()))];
        if (tokens.length === 0) { skip('no_device'); continue; }
        const res = await sendDataFcm(uid, tokens, {
          type:            'MOVIE_TICKET_POLL',
          title:           pushTitleFor(claimed),
          body:            TEXT.pushBody,
          sessionId:       String(session._id),
          pollId:          String(claimed._id),
          idempotencyKey:  pollKey(session._id),
          movieTitle:      session.movieTitle || '',
          recipientUserId: uid,
        });
        if (res && res.delivered) summary.sent += 1; else skip('fcm_failed');
      }
    }
  } catch (err) {
    summary.error = err.message;
    console.error('[MOVIE_TICKET_POLL] notify failed:', err.message);
  }
  await MovieTicketPoll.updateOne({ _id: poll._id }, { $set: { 'notifications.openSent': summary.sent } });
  // Counts and ids only — never names, tokens or text.
  console.log('[MOVIE_TICKET_POLL]', JSON.stringify(summary));
  return summary.sent;
}

async function openDuePolls(now, summary, io) {
  const sessions = await MovieSession.find({
    status:   'active',
    showTime: { $gt: new Date(now), $lte: new Date(now + LEAD_MS) },
    'participants.0': { $exists: true },
  }).sort({ showTime: 1 }).limit(MAX_OPEN_PER_TICK).lean();
  if (sessions.length === 0) return;

  const existing = await MovieTicketPoll.find({ sessionId: { $in: sessions.map(s => s._id) } }).lean();
  const bySession = new Map(existing.map(p => [String(p.sessionId), p]));

  for (const session of sessions) {
    try {
      let poll = bySession.get(String(session._id));
      if (poll) {
        // Rescheduled while open: follow the new time, keep every answer.
        if (poll.status === 'OPEN' && new Date(poll.closesAt).getTime() !== new Date(session.showTime).getTime()) {
          await MovieTicketPoll.updateOne({ _id: poll._id, status: 'OPEN' }, { $set: { closesAt: session.showTime } });
          poll.closesAt = session.showTime;
        }
        if (poll.pollMessageId && poll.notifications && poll.notifications.openClaimedAt) continue;   // all done
      } else {
        // The rule: nobody eligible now → no poll, no message, no notification.
        const eligible = await eligibleMembers(session);
        if (eligible.length === 0) { summary.skippedEmpty += 1; continue; }
        try {
          poll = (await MovieTicketPoll.create({
            sessionId:      session._id,
            status:         'OPEN',
            openedAt:       new Date(now),
            closesAt:       session.showTime,
            eligibleAtOpen: eligible.map(id => new ObjectId(id)),
          })).toObject();
          summary.opened += 1;
          console.log(`[MOVIE_TICKET_POLL] opened session=${session._id} eligible=${eligible.length}`);
        } catch (err) {
          if (!(err && err.code === 11000)) throw err;
          poll = await MovieTicketPoll.findOne({ sessionId: session._id }).lean();   // another tick won
        }
      }
      await postPollMessage(poll, session, io);
      summary.notified += await notifyOpen(poll, session);
    } catch (err) {
      // One bad session must never stop the tick for the others.
      console.error(`[MOVIE_TICKET_POLL] open session=${session._id} failed:`, err.message);
    }
  }
}

// ── Closing ───────────────────────────────────────────────────────────────────

async function closeDuePolls(now, summary, io) {
  const due = await MovieTicketPoll.find({ status: 'OPEN', closesAt: { $lte: new Date(now) } })
    .sort({ closesAt: 1 }).limit(MAX_CLOSE_PER_TICK).lean();
  for (const poll of due) {
    try {
      const closed = await MovieTicketPoll.findOneAndUpdate(
        { _id: poll._id, status: 'OPEN' },
        { $set: { status: 'CLOSED', closedAt: new Date(now) } },
        { new: true },
      ).lean();
      if (!closed) continue;
      summary.closed += 1;
      const session = await MovieSession.findById(poll.sessionId).select('participants').lean();
      if (session) broadcast(io, closed, session.participants);
    } catch (err) {
      console.error(`[MOVIE_TICKET_POLL] close poll=${poll._id} failed:`, err.message);
    }
  }
}

/** One tick. Safe to run every minute, twice, late, or on several servers. */
async function tickMovieTicketPolls(now = Date.now(), io = liveIo()) {
  const summary = { opened: 0, closed: 0, notified: 0, skippedEmpty: 0 };
  await openDuePolls(now, summary, io);
  await closeDuePolls(now, summary, io);
  return summary;
}

// ── Reading and answering ─────────────────────────────────────────────────────

async function loadForMember(userId, sessionId) {
  if (!mongoose.isValidObjectId(sessionId)) return { error: fail(404, 'SESSION_NOT_FOUND', 'Session not found') };
  const session = await MovieSession.findById(sessionId).select('participants status').lean();
  if (!session) return { error: fail(404, 'SESSION_NOT_FOUND', 'Session not found') };
  if (!ids(session.participants).includes(String(userId))) {
    return { error: fail(403, 'NOT_A_MEMBER', 'You are not a member of this hangout') };
  }
  return { session };
}

/** GET /movie-session/:id/ticket-poll — members only; null until the poll opens. */
async function getPoll(userId, sessionId, now = Date.now()) {
  const access = await loadForMember(userId, sessionId);
  if (access.error) return access.error;
  const poll = await MovieTicketPoll.findOne({ sessionId }).lean();
  return { success: true, status: 200, poll: formatPoll(poll, access.session.participants, userId, now) };
}

/**
 * POST /movie-session/:id/ticket-poll { answer: BOOKED | NOT_YET | CANT_MAKE_IT }
 * The caller's own answer (nothing in the body names anyone), current members only,
 * while the poll is open. One answer per person — answering again changes it; two
 * conditional updates mean two taps at once can never leave two answers.
 */
async function castVote(userId, sessionId, body = {}, io = null, now = Date.now()) {
  const answer = body && typeof body.answer === 'string' ? body.answer.trim().toUpperCase() : '';
  if (!MovieTicketPoll.ANSWERS.includes(answer)) {
    return fail(422, 'INVALID_ANSWER', 'Choose one of the options.');
  }
  const access = await loadForMember(userId, sessionId);
  if (access.error) return access.error;
  const poll = await MovieTicketPoll.findOne({ sessionId }).select('_id status closesAt').lean();
  if (!poll) return fail(404, 'POLL_NOT_FOUND', 'There is no ticket check in this hangout yet.');
  const closed = () => fail(409, 'POLL_CLOSED', 'The ticket check has closed.');
  if (poll.status !== 'OPEN' || now >= new Date(poll.closesAt).getTime()) return closed();

  const uid = new ObjectId(String(userId));
  const at = new Date(now);
  const open = { _id: poll._id, status: 'OPEN', closesAt: { $gt: at } };
  const change = () => MovieTicketPoll.findOneAndUpdate(
    { ...open, 'responses.userId': uid },
    { $set: { 'responses.$.answer': answer, 'responses.$.respondedAt': at } },
    { new: true },
  ).lean();
  let updated = await change();
  if (!updated) {
    updated = await MovieTicketPoll.findOneAndUpdate(
      { ...open, 'responses.userId': { $ne: uid } },
      { $push: { responses: { userId: uid, answer, respondedAt: at } } },
      { new: true },
    ).lean();
  }
  if (!updated) updated = await change();          // lost a race with their own other device
  if (!updated) return closed();

  broadcast(io, updated, access.session.participants);
  return { success: true, status: 200, poll: formatPoll(updated, access.session.participants, userId, now) };
}

module.exports = {
  tickMovieTicketPolls,
  getPoll,
  castVote,
  formatPoll,
  TEXT,
  _internal: { tally, eligibleMembers, leadWords, pollKey, LEAD_MS },
};
