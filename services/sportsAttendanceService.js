// services/sportsAttendanceService.js
// -----------------------------------------------------------------------------
// Sports chat enhancement — the attendance check.
//
//   startTime − 1 h   the chat gets "🏀 Your Basketball session starts in 1 hour.
//                     Are you still coming?" with a Yes / No poll, and members are
//                     notified.
//   until startTime   members answer, and may change their answer. Counts update
//                     live; nobody sees who answered what.
//   startTime         the poll closes and the result is posted ("🎉 Looks like
//                     most of the group is still coming! 4 players said yes."),
//                     with one notification.
//
// SCHEDULING. No timer per chat and nothing on the phone: one every-minute tick
// from cronJobs.js — the same node-cron tick the Surprise Activity safety
// reminders use (services/meetupSafetyReminderService.js). All state is in
// MongoDB, so it survives restarts, crashes and deploys; each tick finds what is
// due by time windows, so a missed minute is caught on the next one.
//   open    plans starting in (15 min, 60 min] with at least two players and no
//           poll yet. A check that could only open with under 15 minutes left
//           (the server was down for the whole window) is skipped: it would be
//           noise, not help.
//   close   open polls whose closesAt has passed, however late. If the game has
//           already ended by then, the result is recorded but not posted.
// A poll is ONE document per session (unique sessionId = the idempotency key
// "ATTENDANCE_POLL:<sessionId>"); every step after that is a conditional update
// on it, so a tick run twice, or on two servers, cannot open, close, post or
// notify twice.
//
// WHO. Everyone in the plan when it opens (host included) gets the notification.
// Anyone currently in the plan may answer — a late joiner too. What counts is
// decided from current membership: someone who leaves or is removed after
// answering no longer counts.
//
// NOT ACTIVITY. Nothing here moves SportsSession.lastMessageAt: opening, votes,
// the result and the notifications never extend the chat's 7-day lifetime.
// -----------------------------------------------------------------------------
'use strict';

const mongoose             = require('mongoose');
const SportsPlan           = require('../models/SportsPlan');
const SportsSession        = require('../models/SportsSession');
const SportsMessage        = require('../models/SportsMessage');
const SportsAttendancePoll = require('../models/SportsAttendancePoll');

const { ObjectId } = mongoose.Types;

const chat         = () => require('./sportsChatService');
const sessions     = () => require('./sportsSessionService');
const sportsSocket = () => require('../sockets/sportsSocket');

const MIN = 60 * 1000;
const LEAD_MS          = 60 * MIN;   // opens an hour before the game
const MIN_OPEN_MS      = 15 * MIN;   // …but never with less than this left
const MAX_OPEN_PER_TICK  = 200;
const MAX_CLOSE_PER_TICK = 100;
const RETRY_WINDOW_MS  = 6 * 60 * MIN; // a posted-late result is retried this long

const fail = (status, code, message, extra = {}) => ({ success: false, status, code, message, ...extra });
const pollKey = sessionId => `ATTENDANCE_POLL:${sessionId}`;
const resultKey = sessionId => `ATTENDANCE_RESULT:${sessionId}`;

/** yes / no among the people still in the plan, and the outcome. */
function tally(poll, plan) {
  const members = new Set((plan.playersJoined || []).map(String));
  let yes = 0, no = 0;
  for (const r of poll.responses || []) {
    if (!members.has(String(r.userId))) continue;
    if (r.answer === 'YES') yes += 1; else no += 1;
  }
  const outcome = yes + no === 0 ? 'NO_RESPONSES'
    : yes > no ? 'YES_MAJORITY'
    : no > yes ? 'NO_MAJORITY'
    : 'SPLIT';
  return { yes, no, eligible: members.size, outcome };
}

/** The live counts to every open chat screen, each with its own answer. */
function broadcast(poll, plan) {
  sportsSocket().emitSportsPoll(String(plan._id), String(poll.sessionId),
    userId => chat().formatPoll(poll, plan, userId));
}

// ── Opening ───────────────────────────────────────────────────────────────────

async function postPollMessage(poll, plan, session) {
  if (poll.pollMessageId) return;
  const saved = await chat().announce(session, plan, 'ATTENDANCE_POLL', null, pollKey(session._id),
    { pollId: poll._id, previewText: chat().pollOpenText(plan, poll) });
  const id = saved ? saved._id
    : (await SportsMessage.findOne({ sessionId: session._id, systemKey: pollKey(session._id) }).select('_id').lean() || {})._id;
  if (id) await SportsAttendancePoll.updateOne({ _id: poll._id, pollMessageId: null }, { $set: { pollMessageId: id } });
}

async function notifyOpen(poll, plan, session) {
  if (poll.notifications && poll.notifications.openClaimedAt) return 0;
  // Claim before sending: a second tick (or server) gets nothing to send.
  const claimed = await SportsAttendancePoll.findOneAndUpdate(
    { _id: poll._id, 'notifications.openClaimedAt': null },
    { $set: { 'notifications.openClaimedAt': new Date() } },
    { new: true },
  ).lean();
  if (!claimed) return 0;
  const sport = chat().sportName(plan);
  const lead = chat().pollOpenText(plan, poll).match(/starts in (.+?)\./);
  const body = `Your ${sport} session starts in ${lead ? lead[1] : '1 hour'}. Are you coming?`;
  const res = await chat().notifyMembers(plan, session, poll.eligibleAtOpen || [], () => ({
    type:   'SPORTS_ATTENDANCE_POLL',
    pollId: String(poll._id),
    title:  `${sport} session`,
    body,
  }), 'sports_attendance_poll');
  await SportsAttendancePoll.updateOne({ _id: poll._id }, { $set: { 'notifications.openSent': res.sent } });
  return res.sent;
}

async function openDuePolls(now, summary) {
  const plans = await SportsPlan.find({
    cardStatus: 'open',
    startTime:  { $gt: new Date(now + MIN_OPEN_MS), $lte: new Date(now + LEAD_MS) },
    'playersJoined.1': { $exists: true },
  }).sort({ startTime: 1 }).limit(MAX_OPEN_PER_TICK).lean();
  if (plans.length === 0) return;

  const existing = await SportsAttendancePoll.find({ sportsPlanId: { $in: plans.map(p => p._id) } }).lean();
  const byPlan = new Map(existing.map(p => [String(p.sportsPlanId), p]));

  for (const plan of plans) {
    try {
      let poll = byPlan.get(String(plan._id));
      // Everything already done for this one: the common case, costs nothing more.
      if (poll && poll.pollMessageId && poll.notifications && poll.notifications.openClaimedAt) continue;
      const session = await sessions()._internal.ensureSession(plan);
      if (chat().chatStateOf(session, plan, now) !== 'active') continue;
      if (!poll) {
        try {
          poll = (await SportsAttendancePoll.create({
            sessionId:      session._id,
            sportsPlanId:   plan._id,
            status:         'OPEN',
            openedAt:       new Date(now),
            closesAt:       plan.startTime,
            eligibleAtOpen: plan.playersJoined,
          })).toObject();
          summary.opened += 1;
          console.log(`[SPORTS_ATTENDANCE] opened session=${session._id} plan=${plan._id} members=${plan.playersJoined.length}`);
        } catch (err) {
          if (!(err && err.code === 11000)) throw err;
          poll = await SportsAttendancePoll.findOne({ sessionId: session._id }).lean();   // another tick won
        }
      }
      await postPollMessage(poll, plan, session);
      summary.notified += await notifyOpen(poll, plan, session);
    } catch (err) {
      // One bad plan must never stop the tick for the others.
      console.error(`[SPORTS_ATTENDANCE] open plan=${plan._id} failed:`, err.message);
    }
  }
}

// ── Closing ───────────────────────────────────────────────────────────────────

/** The result message and notification for a closed poll; each at most once. */
async function finishPoll(poll, plan, session) {
  if (!poll.result || !poll.result.announced) return;
  if (!poll.resultMessageId) {
    const saved = await chat().announce(session, plan, 'ATTENDANCE_RESULT', null, resultKey(session._id),
      { pollId: poll._id, previewText: chat().pollResultText(poll) });
    const id = saved ? saved._id
      : (await SportsMessage.findOne({ sessionId: session._id, systemKey: resultKey(session._id) }).select('_id').lean() || {})._id;
    if (id) await SportsAttendancePoll.updateOne({ _id: poll._id, resultMessageId: null }, { $set: { resultMessageId: id } });
  }
  if (poll.notifications && poll.notifications.resultClaimedAt) return;
  const claimed = await SportsAttendancePoll.findOneAndUpdate(
    { _id: poll._id, 'notifications.resultClaimedAt': null },
    { $set: { 'notifications.resultClaimedAt': new Date() } },
    { new: true },
  ).lean();
  if (!claimed) return;
  const r = poll.result;
  const sport = chat().sportName(plan);
  // Nobody answered: only the host hears about it — nobody else needs a push.
  const recipients = r.outcome === 'NO_RESPONSES' ? [String(plan.creatorId)] : (plan.playersJoined || []).map(String);
  const body = r.outcome === 'YES_MAJORITY' ? `${r.yes} of ${r.eligible} players confirmed for ${sport}.`
    : r.outcome === 'NO_RESPONSES' ? `Nobody answered the attendance check for ${sport}.`
    : `${sport} attendance check: ${r.yes} yes, ${r.no} no.`;
  const res = await chat().notifyMembers(plan, session, recipients, () => ({
    type:   'SPORTS_ATTENDANCE_RESULT',
    pollId: String(poll._id),
    title:  `${sport} session`,
    body,
  }), 'sports_attendance_result');
  await SportsAttendancePoll.updateOne({ _id: poll._id }, { $set: { 'notifications.resultSent': res.sent } });
}

async function closeDuePolls(now, summary) {
  const due = await SportsAttendancePoll.find({ status: 'OPEN', closesAt: { $lte: new Date(now) } })
    .sort({ closesAt: 1 }).limit(MAX_CLOSE_PER_TICK).lean();
  for (const poll of due) {
    try {
      const plan = await SportsPlan.findById(poll.sportsPlanId).lean();
      const session = await SportsSession.findById(poll.sessionId).lean();
      let result;
      if (!plan || !session || plan.cardStatus === 'cancelled' || session.status === 'cancelled') {
        result = { yes: 0, no: 0, eligible: 0, outcome: 'CANCELLED', announced: false };
      } else {
        // After the game has ended a result is history, not news: keep it, don't post it.
        result = { ...tally(poll, plan), announced: now < new Date(plan.endTime).getTime() };
      }
      const closed = await SportsAttendancePoll.findOneAndUpdate(
        { _id: poll._id, status: 'OPEN' },
        { $set: { status: 'CLOSED', closedAt: new Date(now), result } },
        { new: true },
      ).lean();
      if (!closed) continue;                      // another tick closed it
      summary.closed += 1;
      console.log(`[SPORTS_ATTENDANCE] closed session=${poll.sessionId} outcome=${result.outcome} yes=${result.yes} no=${result.no} eligible=${result.eligible} posted=${result.announced}`);
      if (plan) broadcast(closed, plan);
      if (plan && session) await finishPoll(closed, plan, session);
    } catch (err) {
      console.error(`[SPORTS_ATTENDANCE] close poll=${poll._id} failed:`, err.message);
    }
  }
}

/** A result whose message or notification did not get done (a crash, an error). */
async function retryUnfinished(now) {
  const stuck = await SportsAttendancePoll.find({
    status:             'CLOSED',
    'result.announced': true,
    closedAt:           { $gt: new Date(now - RETRY_WINDOW_MS) },
    $or: [{ resultMessageId: null }, { 'notifications.resultClaimedAt': null }],
  }).limit(MAX_CLOSE_PER_TICK).lean();
  for (const poll of stuck) {
    try {
      const [plan, session] = await Promise.all([
        SportsPlan.findById(poll.sportsPlanId).lean(),
        SportsSession.findById(poll.sessionId).lean(),
      ]);
      if (plan && session) await finishPoll(poll, plan, session);
    } catch (err) {
      console.error(`[SPORTS_ATTENDANCE] retry poll=${poll._id} failed:`, err.message);
    }
  }
}

/**
 * One tick. Safe to run every minute, twice, late, or on several servers.
 * [now] is injectable for tests; production always uses the server clock.
 */
async function tickSportsAttendance(now = Date.now()) {
  const summary = { opened: 0, closed: 0, notified: 0 };
  await openDuePolls(now, summary);
  await closeDuePolls(now, summary);
  await retryUnfinished(now);
  return summary;
}

// ── Voting ────────────────────────────────────────────────────────────────────

/**
 * POST /sessions/:sessionId/attendance  { answer: 'YES' | 'NO' }
 * Any current member, while the poll is open (server time) and the chat is open.
 * One answer per person: answering again changes it. Two atomic updates — change
 * an existing answer, else add one guarded on there being none — so two taps at
 * once can never leave two answers. The answer is the caller's; nothing in the
 * body names anyone.
 */
async function castVote(user, sessionId, body = {}, now = Date.now()) {
  const answer = body && typeof body.answer === 'string' ? body.answer.trim().toUpperCase() : '';
  if (!SportsAttendancePoll.ANSWERS.includes(answer)) {
    return fail(422, 'INVALID_ANSWER', 'Choose Yes or No.');
  }
  const access = await chat().loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;
  const closed = await chat().readOnlyRefusal(session, plan, now);
  if (closed) return closed;

  const poll = await SportsAttendancePoll.findOne({ sessionId: session._id }).select('_id status closesAt').lean();
  if (!poll) return fail(404, 'POLL_NOT_FOUND', 'There is no attendance check in this chat yet.');
  const pollClosed = () => fail(409, 'POLL_CLOSED', 'The attendance check has closed.');
  if (poll.status !== 'OPEN' || now >= new Date(poll.closesAt).getTime()) return pollClosed();

  const uid = new ObjectId(String(user._id));
  const at = new Date(now);
  const open = { _id: poll._id, status: 'OPEN', closesAt: { $gt: at } };
  const change = () => SportsAttendancePoll.findOneAndUpdate(
    { ...open, 'responses.userId': uid },
    { $set: { 'responses.$.answer': answer, 'responses.$.respondedAt': at } },
    { new: true },
  ).lean();
  let updated = await change();
  if (!updated) {
    updated = await SportsAttendancePoll.findOneAndUpdate(
      { ...open, 'responses.userId': { $ne: uid } },
      { $push: { responses: { userId: uid, answer, respondedAt: at } } },
      { new: true },
    ).lean();
  }
  // Lost a race with this person's own other device: their answer is there now.
  if (!updated) updated = await change();
  if (!updated) return pollClosed();

  broadcast(updated, plan);
  return { success: true, status: 200, poll: chat().formatPoll(updated, plan, user._id) };
}

module.exports = {
  tickSportsAttendance,
  castVote,
  _internal: { tally, LEAD_MS, MIN_OPEN_MS, RETRY_WINDOW_MS, pollKey, resultKey },
};
