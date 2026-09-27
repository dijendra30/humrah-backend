// services/sportsChatService.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 3. The group chat of a Sports session.
//
//   SportsPlan ──1:1── SportsSession ──1:N── SportsSessionMember
//                            └────────1:N── SportsMessage
//
// WHO may read or write: exactly the plan's players (SportsPlan.playersJoined),
// checked on every call — the same authority Phase 2A uses for the session. A
// block with the host hides the whole session; messages from, and events about,
// anyone the caller is in a block pair with are left out of what they see.
//
// WHEN the chat is open — server state and server time only:
//
//   expiresAt = max(lastMessageAt, plan.endTime) + 7 days
//
//   lastMessageAt moves only on QUALIFYING activity — a member's message or a
//   join — and only forward ($max). Opening, reading, scrolling, typing,
//   reactions, leaves, cancellation, list reads and notifications never move it.
//   The plan's end is a floor, not an end: a chat always lasts at least 7 days
//   after its game, and after that as long as people keep talking, with no upper
//   limit. It can never expire BEFORE its game, however early people joined.
//
//   'expired' is worked out on every read and send, and written to the session
//   (status 'expired', expiredAt = the moment it expired) the first time it is
//   seen. A send "claims" activity with one conditional update that only matches
//   a still-open chat; the expiry write is the complementary conditional update.
//   MongoDB applies updates to one document one at a time, so exactly one of
//   them wins a race at the boundary. No timers, no background job: the state
//   is correct after restarts, crashes or months without traffic.
//
// A new session with nobody else in it is not a message: the app shows a
// waiting state from `waiting`, and a send is refused until someone joins.
//
// CHAT ENHANCEMENT — what a member can do to a message, all decided here from
// the database (author = senderId, host = plan.creatorId), never from the body:
//   reply      replyToMessageId, checked on send (same session, a member's
//              message, not deleted, not from someone hidden by a block). The
//              quote is resolved when read — one batch query per page — so it
//              follows edits and never shows deleted text.
//   edit       the author, within 15 minutes of createdAt by the SERVER clock,
//              in an open chat; one conditional update. createdAt is kept.
//   delete for everyone   the author ('USER'), or the host on anyone's message
//              ('HOST' — moderation). The row and text stay for moderation and
//              for replies, pagination and unread counts; the text is never
//              returned again. Deleted messages cannot be edited, reacted to,
//              replied to or deleted again.
//   delete for me          a SportsHiddenMessage row: gone from that member's
//              view only; nothing else changes and nobody is told.
//   link check             see utils/linkSafety.js.
// None of these is chat activity: only a member's message (a reply included)
// and a join move lastMessageAt. Editing or deleting an old message can never
// keep a chat alive.
// -----------------------------------------------------------------------------
'use strict';

const mongoose            = require('mongoose');
const SportsPlan          = require('../models/SportsPlan');
const SportsSession       = require('../models/SportsSession');
const SportsSessionMember = require('../models/SportsSessionMember');
const SportsMessage       = require('../models/SportsMessage');
const SportsHiddenMessage = require('../models/SportsHiddenMessage');
const SportsAttendancePoll = require('../models/SportsAttendancePoll');
const User                = require('../models/User');
const linkSafety          = require('../utils/linkSafety');
const redisService        = require('./redisService');
// The Humrah Rooms reaction allowlist, shared so both chats offer the same set.
const { normalizeReaction, serializeReactions } = require('../utils/roomReactionConfig');

const { ObjectId } = mongoose.Types;

// Required lazily: these modules call into this one.
const planService    = () => require('./sportsPlanService');
const sessionService = () => require('./sportsSessionService');
const sportsSocket   = () => require('../sockets/sportsSocket');
const fcm            = () => require('../utils/fcmHelper');

const DAY_MS          = 24 * 60 * 60 * 1000;
const INACTIVITY_MS   = 7 * DAY_MS;
const PAGE_DEFAULT    = 30;
const PAGE_MAX        = 50;
const TEXT_MAX        = 1000;
const PREVIEW_MAX     = 140;
const CLIENT_ID_RE    = /^[A-Za-z0-9_-]{1,64}$/;
const JOIN_NOTIFY_COOLDOWN_SECONDS = 30 * 60;
// A member may edit their own message for this long after sending it.
const EDIT_WINDOW_MS  = 15 * 60 * 1000;
// Jumping to a reply's original loads at most this many messages to reach it.
const RANGE_MAX       = 200;

const fail = (status, code, message, extra = {}) => ({ success: false, status, code, message, ...extra });
const notFound = () => fail(404, 'SESSION_NOT_FOUND', 'This session does not exist or is no longer available.');
const chatClosed = () => fail(403, 'CHAT_CLOSED', 'This sports session was cancelled, so its chat is read-only.');
const chatExpired = () => fail(403, 'CHAT_EXPIRED', 'This chat expired after 7 days without messages.');
const messageNotFound = () => fail(404, 'MESSAGE_NOT_FOUND', 'That message is not in this chat.');
const messageDeleted = () => fail(409, 'MESSAGE_DELETED', 'That message was deleted.');
const isValidId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const same = (a, b) => String(a) === String(b);
const includesId = (list, id) => (list || []).some(x => same(x, id));
const iso = d => (d ? new Date(d).toISOString() : null);

// ── When the chat is open ─────────────────────────────────────────────────────

/** max(last qualifying activity, the game's end) + 7 days. */
function expiresAtOf(session, plan) {
  const last  = session && session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0;
  const floor = new Date(plan.endTime).getTime();
  return new Date(Math.max(last, floor) + INACTIVITY_MS);
}

/** 'active' | 'expired' | 'cancelled' — the CHAT, which is not the plan's phase. */
function chatStateOf(session, plan, now = Date.now()) {
  if ((session && session.status === 'cancelled') || plan.cardStatus === 'cancelled') return 'cancelled';
  if (session && session.status === 'expired') return 'expired';
  return now >= expiresAtOf(session, plan).getTime() ? 'expired' : 'active';
}

/**
 * Records an expiry the first time it is seen. Conditional on the chat still
 * being quiet at this instant, so a message that got in first keeps it open.
 * @returns the session, updated in place when it was marked.
 */
async function persistExpiryIfDue(session, plan, now = Date.now()) {
  if (!session || session.status !== 'active' || plan.cardStatus === 'cancelled') return session;
  const expiredAt = expiresAtOf(session, plan);
  if (now < expiredAt.getTime()) return session;
  const res = await SportsSession.updateOne(
    {
      _id: session._id,
      status: 'active',
      $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: new Date(now - INACTIVITY_MS) } }],
    },
    { $set: { status: 'expired', expiredAt } },
  );
  if (res.modifiedCount === 1) {
    session.status = 'expired';
    session.expiredAt = expiredAt;
    console.log(`[SPORTS_CHAT_EXPIRED] session=${session._id} plan=${plan._id} expiredAt=${expiredAt.toISOString()}`);
  }
  return session;
}

/**
 * The newest-message preview kept on the session. Written with a guard so an
 * older message can never replace a newer one, and — for qualifying activity —
 * lastMessageAt moved forward with $max. When [conditional], it only applies to
 * a chat that is still open at [now]: that is the send's claim (see header).
 * @returns the updated session, or null when the claim was refused.
 */
function recordMessage(session, plan, preview, now, { qualifies, conditional }) {
  const filter = { _id: session._id };
  if (conditional) {
    filter.status = 'active';
    // Before the floor has passed nothing can have expired; after it, the last
    // activity must be within the window at this instant.
    if (now >= new Date(plan.endTime).getTime() + INACTIVITY_MS) {
      filter.lastMessageAt = { $gt: new Date(now - INACTIVITY_MS) };
    }
  }
  const set = {
    lastMessage: {
      $cond: [
        { $or: [
          { $eq: [{ $ifNull: ['$lastMessage', null] }, null] },
          { $lte: ['$lastMessage.createdAt', preview.createdAt] },
        ] },
        // $literal: message text is data, never an expression ("$5 each" stays text).
        { $literal: preview },
        '$lastMessage',
      ],
    },
  };
  if (qualifies) set.lastMessageAt = { $max: ['$lastMessageAt', preview.createdAt] };
  return SportsSession.findOneAndUpdate(filter, [{ $set: set }], { new: true }).lean();
}

function previewOf(m) {
  const isText = m.messageType === 'TEXT';
  return {
    messageId:     m._id ? new ObjectId(String(m._id)) : null,
    messageType:   m.messageType,
    text:          isText ? String(m.text).slice(0, PREVIEW_MAX) : null,
    senderId:      isText ? new ObjectId(String(m.senderId)) : null,
    systemEvent:   isText ? null : m.systemEvent,
    subjectUserId: !isText && m.subjectUserId ? new ObjectId(String(m.subjectUserId)) : null,
    deletionType:  null,
    createdAt:     new Date(m.createdAt),
  };
}

// ── Access ────────────────────────────────────────────────────────────────────

/** The session and plan, for a current member — or the refusal to return. */
async function loadForMember(user, sessionId) {
  if (!isValidId(sessionId)) return { error: notFound() };
  const session = await SportsSession.findById(sessionId).lean();
  if (!session) return { error: notFound() };
  const plan = await SportsPlan.findById(session.sportsPlanId).lean();
  if (!plan) return { error: notFound() };
  if (await planService()._internal.isBlockedPair(user, plan.creatorId)) return { error: notFound() };
  if (!includesId(plan.playersJoined, user._id)) {
    return { error: fail(403, 'NOT_A_SESSION_MEMBER', 'Only people in this plan can open its chat.',
      { sportsPlanId: String(plan._id), removed: includesId(plan.kickedPlayers, user._id) }) };
  }
  return { session, plan };
}

/** Why this chat takes no changes right now (cancelled / expired), or null. */
async function readOnlyRefusal(session, plan, now) {
  const state = chatStateOf(session, plan, now);
  if (state === 'cancelled') return chatClosed();
  if (state === 'expired') {
    await persistExpiryIfDue(session, plan, now);
    return chatExpired();
  }
  return null;
}

// ── What a message looks like to the app ──────────────────────────────────────

const lite = u => ({ id: String(u._id), firstName: u.firstName || 'Someone', profilePhoto: u.profilePhoto || null });

const sportName = plan => {
  const raw = (plan && (plan.customSportName || plan.sportType)) || 'Sports';
  return String(raw).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

const SPORT_EMOJI = Object.freeze({
  basketball: '🏀', football: '⚽', cricket: '🏏', badminton: '🏸', tennis: '🎾',
  table_tennis: '🏓', running: '🏃', cycling: '🚴', gym: '🏋️', yoga: '🧘',
});
const sportEmoji = plan => SPORT_EMOJI[plan && plan.sportType] || '🏅';
const players = n => `${n} player${n === 1 ? '' : 's'}`;

/** "1 hour" normally; the real lead when the check opened late (after a restart). */
function leadText(poll) {
  const mins = poll ? Math.round((new Date(poll.closesAt) - new Date(poll.openedAt)) / 60000) : 60;
  return mins >= 55 ? '1 hour' : `${Math.max(1, mins)} minutes`;
}

/** The attendance check's opening line. */
function pollOpenText(plan, poll) {
  return `${sportEmoji(plan)} Your ${sportName(plan)} session starts in ${leadText(poll)}. Are you still coming?`;
}

/** The result, as posted at the game's start. Never guilt, never urgency. */
function pollResultText(poll) {
  const r = poll && poll.result;
  if (!r) return 'The attendance check has closed.';
  switch (r.outcome) {
    case 'YES_MAJORITY': return `🎉 Looks like most of the group is still coming! ${players(r.yes)} said yes.`;
    case 'NO_MAJORITY':  return `Looks like most of the group can't make it. ${players(r.no)} said no.`;
    case 'SPLIT':        return `It's a split. ${players(r.yes)} ${r.yes === 1 ? 'is' : 'are'} coming and ${r.no} ${r.no === 1 ? "isn't" : "aren't"}.`;
    case 'NO_RESPONSES': return 'No attendance responses yet.';
    default:             return 'The attendance check has closed.';
  }
}

function systemText(event, name) {
  const who = name || 'Someone';
  switch (event) {
    case 'MEMBER_JOINED':     return `${who} joined the session`;
    case 'MEMBER_LEFT':       return `${who} left the session`;
    case 'MEMBER_REMOVED':    return `${who} was removed from the session by the host`;
    case 'SESSION_CANCELLED': return 'Sports session cancelled by the host';
    case 'ATTENDANCE_POLL':   return 'Attendance check: are you still coming?';
    case 'ATTENDANCE_RESULT': return 'The attendance check has closed.';
    default:                  return 'Session updated';
  }
}

/**
 * Everything a page of messages needs besides the messages, in a fixed number of
 * batch reads whatever the page size (never one per message): the people named,
 * the originals being replied to, which of those the viewer hid, and the polls.
 *
 * @param viewer   the reader (null for a broadcast built for everyone)
 * @param blocked  ids the reader is in a block pair with (a Set of strings)
 */
async function hydrate(messages, { plan, viewer = null, blocked = new Set(), known = [] }) {
  const replyIds = [...new Set(messages
    .filter(m => m.messageType === 'TEXT' && !m.deletedAt && m.replyToMessageId)
    .map(m => String(m.replyToMessageId)))];
  const pollIds = [...new Set(messages.filter(m => m.pollId).map(m => String(m.pollId)))];
  const sessionId = messages.length ? messages[0].sessionId : null;

  const [replies, hidden, polls] = await Promise.all([
    replyIds.length
      ? SportsMessage.find({ _id: { $in: replyIds }, sessionId })
        .select('messageType senderId text deletedAt deletionType').lean()
      : [],
    replyIds.length && viewer
      ? SportsHiddenMessage.find({ userId: viewer._id, messageId: { $in: replyIds } }).select('messageId').lean()
      : [],
    pollIds.length ? SportsAttendancePoll.find({ _id: { $in: pollIds } }).lean() : [],
  ]);
  const users = await usersFor([...messages, ...replies], [viewer, ...known]);
  return {
    plan,
    viewerId: viewer ? String(viewer._id) : null,
    blocked,
    users,
    replies: new Map(replies.map(r => [String(r._id), r])),
    hiddenForMe: new Set(hidden.map(h => String(h.messageId))),
    polls: new Map(polls.map(p => [String(p._id), p])),
  };
}

/** One batch read for every sender and subject on a page — never one per message. */
async function usersFor(messages, known = []) {
  const byId = new Map(known.filter(Boolean).map(u => [String(u._id), u]));
  const ids = new Set();
  for (const m of messages) {
    if (m.senderId && !byId.has(String(m.senderId))) ids.add(String(m.senderId));
    if (m.subjectUserId && !byId.has(String(m.subjectUserId))) ids.add(String(m.subjectUserId));
  }
  if (ids.size) {
    const users = await User.find({ _id: { $in: [...ids] } }).select('firstName profilePhoto').lean();
    for (const u of users) byId.set(String(u._id), u);
  }
  return byId;
}

/**
 * The quote on a reply, for one reader. Only ever: who wrote the original and a
 * short preview of its CURRENT text — or why there is none (deleted, hidden by
 * the reader, from someone in a block pair with them, or gone).
 */
function formatReply(targetId, ctx) {
  const t = ctx.replies.get(String(targetId));
  const out = {
    messageId: String(targetId), senderId: null, senderFirstName: null, text: null,
    deleted: false, deletionType: null, hiddenForYou: false, unavailable: false,
  };
  if (!t || (t.senderId && ctx.blocked.has(String(t.senderId)))) return { ...out, unavailable: true };
  const who = ctx.users.get(String(t.senderId));
  out.senderId = String(t.senderId);
  out.senderFirstName = (who && who.firstName) || 'Someone';
  if (t.deletedAt) return { ...out, deleted: true, deletionType: t.deletionType || 'USER' };
  if (ctx.viewerId && ctx.hiddenForMe.has(String(targetId))) return { ...out, hiddenForYou: true };
  return { ...out, text: String(t.text || '').slice(0, PREVIEW_MAX) };
}

/**
 * An attendance check as one reader sees it. Counts are anonymous and count only
 * people still in the plan (live) — or, once closed, the result frozen at close.
 */
function formatPoll(poll, plan, viewerId) {
  if (!poll) return null;
  const members = new Set(((plan && plan.playersJoined) || []).map(String));
  let yes = 0, no = 0, participants;
  if (poll.status === 'CLOSED' && poll.result) {
    ({ yes, no } = poll.result);
    participants = poll.result.eligible;
  } else {
    for (const r of poll.responses || []) {
      if (!members.has(String(r.userId))) continue;
      if (r.answer === 'YES') yes += 1; else no += 1;
    }
    participants = members.size;
  }
  const mine = viewerId ? (poll.responses || []).find(r => same(r.userId, viewerId)) : null;
  return {
    id:           String(poll._id),
    status:       poll.status,
    yes,
    no,
    participants,
    myAnswer:     mine ? mine.answer : null,
    closesAt:     iso(poll.closesAt),
    outcome:      poll.result ? poll.result.outcome : null,
  };
}

function formatMessage(m, ctx) {
  const isText  = m.messageType === 'TEXT';
  const deleted = isText && !!m.deletedAt;
  const sender  = isText ? ctx.users.get(String(m.senderId)) : null;
  const subject = !isText && m.subjectUserId ? ctx.users.get(String(m.subjectUserId)) : null;
  const poll    = m.pollId ? ctx.polls.get(String(m.pollId)) : null;
  let text;
  if (isText) text = deleted ? null : m.text;
  else if (m.systemEvent === 'ATTENDANCE_POLL') text = pollOpenText(ctx.plan, poll);
  else if (m.systemEvent === 'ATTENDANCE_RESULT') text = pollResultText(poll);
  else text = systemText(m.systemEvent, subject && subject.firstName);
  const created = new Date(m.createdAt).getTime();
  return {
    id:              String(m._id),
    sessionId:       String(m.sessionId),
    type:            m.messageType,
    text,
    sender:          isText ? (sender ? lite(sender) : { id: String(m.senderId), firstName: 'Someone', profilePhoto: null }) : null,
    systemEvent:     isText ? null : (m.systemEvent || null),
    subjectUserId:   !isText && m.subjectUserId ? String(m.subjectUserId) : null,
    clientMessageId: m.clientMessageId || null,
    // Nothing of a deleted message survives but its place: no text, no reactions,
    // no quote.
    reactions:       deleted ? [] : serializeReactions(m.reactions, ctx.viewerId),
    createdAt:       iso(m.createdAt),
    editedAt:        deleted ? null : iso(m.editedAt),
    editableUntil:   isText && !deleted ? iso(created + EDIT_WINDOW_MS) : null,
    deleted,
    deletionType:    deleted ? (m.deletionType || 'USER') : null,
    replyTo:         isText && !deleted && m.replyToMessageId ? formatReply(m.replyToMessageId, ctx) : null,
    poll:            poll ? formatPoll(poll, ctx.plan, ctx.viewerId) : null,
  };
}

/**
 * The Messages → Sessions preview line, or null (no messages, or from someone
 * hidden). A deleted newest message says so; one the reader hid for themselves
 * says that — neither ever shows the old text.
 */
function formatPreview(session, usersById, hidden = new Set(), hiddenForMe = new Set()) {
  const lm = session.lastMessage;
  if (!lm) return null;
  const isText = lm.messageType === 'TEXT';
  const who = isText ? lm.senderId : lm.subjectUserId;
  if (who && hidden.has(String(who))) return null;
  const person = who ? usersById.get(String(who)) : null;
  const base = {
    type:            lm.messageType,
    senderId:        isText && lm.senderId ? String(lm.senderId) : null,
    senderFirstName: isText ? ((person && person.firstName) || 'Someone') : null,
    systemEvent:     isText ? null : lm.systemEvent,
    createdAt:       iso(lm.createdAt),
    deleted:         false,
    deletionType:    null,
    hiddenForYou:    false,
  };
  if (isText && lm.deletionType) {
    return { ...base, text: lm.deletionType === 'HOST' ? 'Message deleted by host' : 'Message deleted', deleted: true, deletionType: lm.deletionType };
  }
  if (lm.messageId && hiddenForMe.has(String(lm.messageId))) {
    return { ...base, text: 'You deleted this message', hiddenForYou: true };
  }
  let text;
  if (isText) text = lm.text;
  // The attendance lines are written into the preview when posted (no names in them).
  else if ((lm.systemEvent === 'ATTENDANCE_POLL' || lm.systemEvent === 'ATTENDANCE_RESULT') && lm.text) text = lm.text;
  else text = systemText(lm.systemEvent, person && person.firstName);
  return { ...base, text };
}

/** The chat fields a session carries in every response. */
function chatInfo(session, plan, member, now = Date.now()) {
  const state = chatStateOf(session, plan, now);
  const memberCount = (plan.playersJoined || []).length;
  return {
    chatState:  state,
    expiresAt:  state === 'active' ? iso(expiresAtOf(session, plan)) : null,
    expiredAt:  state === 'expired' ? iso(session.expiredAt || expiresAtOf(session, plan)) : null,
    waiting:    memberCount < 2,
    joinsOpen:  plan.cardStatus === 'open' && now < new Date(plan.startTime).getTime(),
    canSend:    state === 'active' && memberCount >= 2,
    lastReadAt: member && member.lastReadAt ? iso(member.lastReadAt) : null,
  };
}

// ── Reading ───────────────────────────────────────────────────────────────────

const clampLimit = raw => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, PAGE_MAX) : PAGE_DEFAULT;
};

/** Everyone the user is in a block pair with, as a Set of id strings. */
const blockedSet = async user => new Set((await planService()._internal.blockedCounterparts(user)).map(String));

/** (createdAt, _id) of a message in this session, or null. */
const cursorOf = (sessionId, id) =>
  SportsMessage.findOne({ _id: id, sessionId }).select('createdAt').lean();

/**
 * GET /sessions/:sessionId/messages?before=<messageId>&limit=<n>
 * Newest first, at most 50 per page, cursor = the oldest message already shown.
 * Readable in every chat state: an expired or cancelled chat keeps its history.
 *
 * &until=<messageId> (with before): everything from the one already shown back
 * to and including [until] — how the app reaches the original of a reply without
 * leaving a gap. At most 200 messages; further back than that, `reachedUntil` is
 * false and nothing is returned (the app says so instead of loading the history).
 *
 * Messages the caller hid ("delete for me") are left out of the page; `scanned`
 * is how many the page covered before that, and nextBefore still moves past them.
 */
async function listMessages(user, sessionId, query = {}) {
  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;

  let limit = clampLimit(query.limit);
  const and = [{ sessionId: session._id }];
  const blocked = await blockedSet(user);
  if (blocked.size) {
    const hidden = [...blocked].map(id => new ObjectId(id));
    and.push({ senderId: { $nin: hidden } }, { subjectUserId: { $nin: hidden } });
  }
  const badCursor = () => fail(422, 'INVALID_CURSOR', 'That page of messages is not available.');
  if (query.before !== undefined && query.before !== '') {
    if (!isValidId(String(query.before))) return badCursor();
    const cursor = await cursorOf(session._id, query.before);
    if (!cursor) return badCursor();
    and.push({ $or: [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
    ] });
  }
  let until = null;
  if (query.until !== undefined && query.until !== '') {
    if (!isValidId(String(query.until))) return badCursor();
    until = await cursorOf(session._id, query.until);
    if (!until) return badCursor();
    and.push({ $or: [
      { createdAt: { $gt: until.createdAt } },
      { createdAt: until.createdAt, _id: { $gte: until._id } },
    ] });
    limit = RANGE_MAX;
  }

  const rows = await SportsMessage.find({ $and: and }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  let page = hasMore ? rows.slice(0, limit) : rows;
  const scanned = page.length;
  const nextBefore = hasMore ? String(page[page.length - 1]._id) : null;
  const reachedUntil = until ? !hasMore && page.some(m => same(m._id, until._id)) : null;
  if (until && !reachedUntil) page = [];

  if (page.length) {
    const hiddenRows = await SportsHiddenMessage.find({ userId: user._id, messageId: { $in: page.map(m => m._id) } })
      .select('messageId').lean();
    if (hiddenRows.length) {
      const gone = new Set(hiddenRows.map(h => String(h.messageId)));
      page = page.filter(m => !gone.has(String(m._id)));
    }
  }
  const ctx = await hydrate(page, { plan, viewer: user, blocked });
  const out = {
    success:    true,
    status:     200,
    messages:   page.map(m => formatMessage(m, ctx)),
    hasMore,
    nextBefore,
    scanned,
  };
  if (until) out.reachedUntil = reachedUntil;
  return out;
}

// ── Sending ───────────────────────────────────────────────────────────────────

/** Trimmed text, or the reason it cannot be sent. */
function cleanText(raw) {
  if (typeof raw !== 'string') return { error: 'Write a message first.' };
  const text = raw
    .replace(/\r\n?/g, '\n')
    // Control characters other than newline and tab never reach the database.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!text) return { error: 'Write a message first.' };
  if (text.length > TEXT_MAX) return { error: `Messages can be up to ${TEXT_MAX} characters.` };
  return { text };
}

/** Why this chat cannot take a message right now, or null. */
async function sendRefusal(session, plan, now) {
  const closed = await readOnlyRefusal(session, plan, now);
  if (closed) return closed;
  if ((plan.playersJoined || []).length < 2) {
    return fail(409, 'WAITING_FOR_PLAYERS', 'You can chat once someone else joins.');
  }
  return null;
}

/**
 * The message a reply answers, or the reason it cannot be answered: it must be a
 * member's message in THIS session, not deleted, and not from someone in a block
 * pair with the sender.
 */
async function replyTarget(user, session, raw) {
  const invalid = msg => ({ error: fail(422, 'INVALID_REPLY', msg) });
  if (typeof raw !== 'string' || !isValidId(raw)) return invalid('That message is not in this chat.');
  const target = await SportsMessage.findOne({ _id: raw, sessionId: session._id })
    .select('messageType senderId deletedAt').lean();
  if (!target) return invalid('That message is not in this chat.');
  if (target.messageType !== 'TEXT') return invalid('Updates in the chat cannot be replied to.');
  if ((await blockedSet(user)).has(String(target.senderId))) return invalid('That message is not in this chat.');
  if (target.deletedAt) return { error: fail(409, 'MESSAGE_DELETED', 'That message was deleted, so it cannot be replied to.') };
  return { id: target._id };
}

/**
 * POST /sessions/:sessionId/messages  { text, clientMessageId?, replyToMessageId? }
 * The sender is the authenticated caller — nothing in the body can change that.
 * A retry with the same clientMessageId returns the message already saved.
 * A reply is an ordinary message: activity, unread, editable, deletable.
 */
async function sendMessage(user, sessionId, body = {}) {
  const cleaned = cleanText(body && body.text);
  if (cleaned.error) return fail(422, 'INVALID_MESSAGE', cleaned.error);
  let clientMessageId = null;
  if (body && body.clientMessageId != null) {
    if (typeof body.clientMessageId !== 'string' || !CLIENT_ID_RE.test(body.clientMessageId)) {
      return fail(422, 'INVALID_MESSAGE', 'Invalid message id.');
    }
    clientMessageId = body.clientMessageId;
  }

  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;

  const forSender = async doc => formatMessage(doc, await hydrate([doc], { plan, viewer: user, blocked: await blockedSet(user) }));
  const duplicate = async () => {
    const existing = await SportsMessage.findOne({ sessionId: session._id, senderId: user._id, clientMessageId }).lean();
    return existing ? { success: true, status: 200, duplicate: true, message: await forSender(existing) } : null;
  };
  if (clientMessageId) {
    const again = await duplicate();
    if (again) return again;
  }

  const now = Date.now();
  const refusal = await sendRefusal(session, plan, now);
  if (refusal) return refusal;

  let replyToMessageId = null;
  if (body && body.replyToMessageId != null && body.replyToMessageId !== '') {
    const target = await replyTarget(user, session, body.replyToMessageId);
    if (target.error) return target.error;
    replyToMessageId = target.id;
  }

  // Claim first: this single conditional update is the decision that the chat was
  // open when the message arrived. Then the message is written with that time.
  const draft = {
    _id:          new ObjectId(),
    sessionId:    session._id,
    sportsPlanId: plan._id,
    messageType:  'TEXT',
    senderId:     user._id,
    text:         cleaned.text,
    clientMessageId,
    replyToMessageId,
    createdAt:    new Date(now),
    updatedAt:    new Date(now),
  };
  const claimed = await recordMessage(session, plan, previewOf(draft), now, { qualifies: true, conditional: true });
  if (!claimed) {
    // Lost to an expiry or a cancellation that landed first.
    const fresh = await SportsSession.findById(session._id).lean();
    if (fresh && chatStateOf(fresh, plan, now) === 'cancelled') return chatClosed();
    await persistExpiryIfDue(fresh || session, plan, now);
    return chatExpired();
  }

  let saved;
  try {
    saved = await new SportsMessage(draft).save({ timestamps: false });
  } catch (err) {
    // The same send arrived twice at once; the first one is the message.
    if (err && err.code === 11000 && clientMessageId) {
      const again = await duplicate();
      if (again) return again;
    }
    throw err;
  }

  const doc = saved.toObject();
  const message = await forSender(doc);
  // Everyone else gets the neutral copy; the socket adjusts a quote per reader
  // (a blocked author's words, or an original that reader hid, are not shown).
  const broadcast = replyToMessageId ? formatMessage(doc, await hydrate([doc], { plan })) : message;
  sportsSocket().emitSportsMessage(String(plan._id), broadcast, user._id);
  return { success: true, status: 201, message };
}

// ── Editing and deleting ──────────────────────────────────────────────────────

/** A message of this session the caller can see, or the refusal. */
async function visibleMessage(user, session, messageId, fields) {
  if (!isValidId(messageId)) return { error: messageNotFound() };
  const m = await SportsMessage.findOne({ _id: messageId, sessionId: session._id }).select(fields).lean();
  if (!m) return { error: messageNotFound() };
  if (m.senderId && (await blockedSet(user)).has(String(m.senderId))) return { error: messageNotFound() };
  return { message: m };
}

/**
 * PATCH /sessions/:sessionId/messages/:messageId  { text }
 * The author only, a member's (TEXT) message only, not deleted, in an open chat,
 * and within 15 minutes of when it was sent — by the SERVER's clock. One
 * conditional update decides it, so a request that arrives a moment too late, or
 * after a delete, changes nothing. Two edits at once: the later one stands, and
 * every screen converges on it through the socket event. Not activity:
 * lastMessageAt never moves.
 */
async function editMessage(user, sessionId, messageId, body = {}, now = Date.now()) {
  const cleaned = cleanText(body && body.text);
  if (cleaned.error) return fail(422, 'INVALID_MESSAGE', cleaned.error);
  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;
  const closed = await readOnlyRefusal(session, plan, now);
  if (closed) return closed;

  const found = await visibleMessage(user, session, messageId, 'messageType senderId text deletedAt createdAt');
  if (found.error) return found.error;
  const m = found.message;
  if (m.messageType !== 'TEXT') return fail(422, 'CANNOT_EDIT', 'Updates in the chat cannot be edited.');
  if (!same(m.senderId, user._id)) return fail(403, 'NOT_MESSAGE_AUTHOR', 'You can only edit your own messages.');
  if (m.deletedAt) return messageDeleted();
  const windowPassed = () => fail(409, 'EDIT_WINDOW_PASSED', 'Messages can only be edited for 15 minutes after sending.');
  if (now - new Date(m.createdAt).getTime() > EDIT_WINDOW_MS) return windowPassed();

  const blocked = await blockedSet(user);
  const reply = async doc => ({ success: true, status: 200, message: formatMessage(doc, await hydrate([doc], { plan, viewer: user, blocked })) });
  if (m.text === cleaned.text) {
    // Nothing to change: no write, no "edited" mark, no event.
    return reply(await SportsMessage.findById(m._id).lean());
  }

  const at = new Date(now);
  const updated = await SportsMessage.findOneAndUpdate(
    {
      _id: m._id,
      sessionId: session._id,
      messageType: 'TEXT',
      senderId: user._id,
      deletedAt: null,
      createdAt: { $gte: new Date(now - EDIT_WINDOW_MS) },
    },
    { $set: { text: cleaned.text, editedAt: at, updatedAt: at } },
    { new: true, timestamps: false },
  ).lean();
  if (!updated) {
    const again = await SportsMessage.findById(m._id).select('deletedAt').lean();
    return again && again.deletedAt ? messageDeleted() : windowPassed();
  }

  // The newest message's preview follows the edit.
  await SportsSession.updateOne(
    { _id: session._id, 'lastMessage.messageId': updated._id, 'lastMessage.deletionType': null },
    { $set: { 'lastMessage.text': cleaned.text.slice(0, PREVIEW_MAX) } },
  );
  sportsSocket().emitSportsMessageUpdated(String(plan._id), {
    sessionId: String(session._id),
    messageId: String(updated._id),
    text:      updated.text,
    editedAt:  iso(updated.editedAt),
  }, user._id);
  return reply(updated);
}

/**
 * DELETE /sessions/:sessionId/messages/:messageId — delete for everyone.
 * Its author may ('USER'); so may the host, on anyone's message ('HOST',
 * moderation). The host is plan.creatorId, read from the database. The message
 * keeps its place as "Message deleted" / "Message deleted by host"; its text is
 * kept for moderation but never returned. Not activity. Once only.
 */
async function deleteForEveryone(user, sessionId, messageId, now = Date.now()) {
  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;
  const closed = await readOnlyRefusal(session, plan, now);
  if (closed) return closed;

  const found = await visibleMessage(user, session, messageId, 'messageType senderId deletedAt');
  if (found.error) return found.error;
  const m = found.message;
  if (m.messageType !== 'TEXT') return fail(422, 'CANNOT_DELETE', 'Updates in the chat cannot be deleted.');
  if (m.deletedAt) return messageDeleted();
  const isAuthor = same(m.senderId, user._id);
  const isHost = same(plan.creatorId, user._id);
  if (!isAuthor && !isHost) {
    return fail(403, 'NOT_ALLOWED_TO_DELETE', 'Only the person who sent this message, or the host, can delete it for everyone.');
  }
  const deletionType = isAuthor ? 'USER' : 'HOST';

  const at = new Date(now);
  const filter = { _id: m._id, sessionId: session._id, messageType: 'TEXT', deletedAt: null };
  if (isAuthor) filter.senderId = user._id;
  const updated = await SportsMessage.findOneAndUpdate(
    filter,
    { $set: { deletedAt: at, deletedBy: user._id, deletionType, updatedAt: at } },
    { new: true, timestamps: false },
  ).lean();
  if (!updated) return messageDeleted();

  await SportsSession.updateOne(
    { _id: session._id, 'lastMessage.messageId': updated._id },
    { $set: { 'lastMessage.text': null, 'lastMessage.deletionType': deletionType } },
  );
  if (deletionType === 'HOST') {
    // Ids only — never the text.
    console.log(`[SPORTS_CHAT_MODERATION] host_delete session=${session._id} message=${updated._id} host=${user._id} author=${updated.senderId}`);
  }
  sportsSocket().emitSportsMessageDeleted(String(plan._id), {
    sessionId:    String(session._id),
    messageId:    String(updated._id),
    deletionType,
    deletedAt:    iso(at),
  });
  const ctx = await hydrate([updated], { plan, viewer: user, blocked: await blockedSet(user) });
  return { success: true, status: 200, message: formatMessage(updated, ctx) };
}

/**
 * POST /sessions/:sessionId/messages/:messageId/hide — delete for me.
 * Only the caller stops seeing it. Nothing else changes, nobody is told (the
 * caller's own other devices are). Works in every chat state — it is a view
 * preference, not a change to the chat. Repeating it is harmless.
 */
async function hideMessage(user, sessionId, messageId) {
  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;
  const found = await visibleMessage(user, session, messageId, 'messageType');
  if (found.error) return found.error;
  if (found.message.messageType !== 'TEXT') return fail(422, 'CANNOT_DELETE', 'Updates in the chat cannot be deleted.');
  try {
    await SportsHiddenMessage.updateOne(
      { userId: user._id, messageId: found.message._id },
      { $setOnInsert: { userId: user._id, sessionId: session._id, messageId: found.message._id } },
      { upsert: true },
    );
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;   // two at once: already hidden
  }
  sportsSocket().emitToUser(user._id, 'sports_message_hidden', {
    planId:    String(plan._id),
    sessionId: String(session._id),
    messageId: String(found.message._id),
  });
  return { success: true, status: 200, messageId: String(found.message._id), hidden: true };
}

/**
 * POST /sessions/:sessionId/messages/:messageId/link-check  { url }
 * The verdict on a link the caller is about to open. The link must appear, as
 * written, in a message of this chat the caller can see — so this cannot be used
 * to check arbitrary URLs. See utils/linkSafety.js for what the verdict means.
 */
async function checkMessageLink(user, sessionId, messageId, body = {}) {
  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session } = access;
  const found = await visibleMessage(user, session, messageId, 'messageType text deletedAt');
  if (found.error) return found.error;
  const m = found.message;
  if (m.messageType !== 'TEXT' || m.deletedAt) return messageNotFound();
  const raw = body && typeof body.url === 'string' ? body.url.trim() : '';
  const parsed = linkSafety.parseWebUrl(raw);
  if (!parsed) return fail(422, 'INVALID_LINK', 'That is not a web link Humrah can open.');
  if (!String(m.text || '').includes(raw)) return fail(422, 'INVALID_LINK', 'That link is not in this message.');
  const result = await linkSafety.checkLink(parsed);
  return {
    success:     true,
    status:      200,
    url:         parsed.href,
    host:        parsed.host,
    secure:      parsed.secure,
    verdict:     result.verdict,
    checkedBy:   result.checkedBy,
    threatTypes: result.threatTypes || [],
  };
}

// ── Read state ────────────────────────────────────────────────────────────────

/**
 * POST /sessions/:sessionId/read — the caller has seen the chat up to now.
 * Only ever moves forward, so two devices cannot move it back. Never called by
 * a list read, a session read or a notification; never counts as activity.
 */
async function markRead(user, sessionId) {
  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;
  const now = new Date();
  const forward = () => SportsSessionMember.findOneAndUpdate(
    { sessionId: session._id, userId: user._id, status: 'JOINED' },
    [{ $set: { lastReadAt: { $max: ['$lastReadAt', now] } } }],
    { new: true },
  ).lean();

  let member = await forward();
  if (!member) {
    // In the plan but the member row missed a sync write: repair, then retry once.
    await sessionService()._internal.reconcile(plan, session);
    member = await forward();
  }
  if (!member) return fail(403, 'NOT_A_SESSION_MEMBER', 'Only people in this plan can open its chat.', { sportsPlanId: String(plan._id) });
  return { success: true, status: 200, lastReadAt: iso(member.lastReadAt) };
}

/**
 * Unread messages per session for one member, in ONE aggregation: messages newer
 * than both their last read and their (latest) join, not their own, not about
 * them, and not from anyone they are in a block pair with.
 */
async function unreadCounts(userId, entries, hidden = []) {
  const branches = entries
    .filter(e => e.session && e.session.lastMessage)
    .map(e => {
      const floors = [e.member && e.member.lastReadAt, e.member && e.member.joinedAt]
        .filter(Boolean).map(d => new Date(d).getTime());
      const since = new Date(floors.length ? Math.max(...floors) : 0);
      // Nothing newer than the preview means nothing unread: skip the branch.
      if (new Date(e.session.lastMessage.createdAt) <= since) return null;
      return { sessionId: e.session._id, createdAt: { $gt: since } };
    })
    .filter(Boolean);
  if (branches.length === 0) return new Map();

  const uid = new ObjectId(String(userId));
  const hiddenIds = hidden.map(h => new ObjectId(String(h)));
  const rows = await SportsMessage.aggregate([
    { $match: { $or: branches } },
    { $match: {
      $or: [
        { messageType: 'TEXT', senderId: { $ne: uid, $nin: hiddenIds } },
        { messageType: 'SYSTEM', subjectUserId: { $ne: uid, $nin: hiddenIds } },
      ],
    } },
    { $group: { _id: '$sessionId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n]));
}

// ── Reactions ─────────────────────────────────────────────────────────────────

/**
 * POST (emoji) / DELETE (no emoji) /sessions/:sessionId/messages/:messageId/reaction
 * One emoji per person per message; changing it moves them. Rooms' single
 * pipeline update — no read-modify-write, no duplicate entries. Not activity.
 */
async function setReaction(user, sessionId, messageId, rawEmoji, { remove = false } = {}) {
  const emoji = remove ? null : normalizeReaction(rawEmoji);
  if (!remove && !emoji) return fail(422, 'UNSUPPORTED_REACTION', 'That reaction is not available.');
  if (!isValidId(messageId)) return fail(404, 'MESSAGE_NOT_FOUND', 'That message is not in this chat.');

  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;
  const closed = await readOnlyRefusal(session, plan, Date.now());
  if (closed) return closed;

  const found = await visibleMessage(user, session, messageId, 'messageType senderId deletedAt');
  if (found.error) return found.error;
  const message = found.message;
  if (message.messageType !== 'TEXT') return fail(422, 'CANNOT_REACT', 'Updates in the chat cannot have reactions.');
  // A deleted message keeps its place, nothing else — no reactions either way.
  if (message.deletedAt) return messageDeleted();

  const uid = new ObjectId(String(user._id));
  const stripped = {
    $map: {
      input: { $ifNull: ['$reactions', []] },
      as: 'r',
      in: { emoji: '$$r.emoji', userIds: { $filter: { input: '$$r.userIds', as: 'u', cond: { $ne: ['$$u', uid] } } } },
    },
  };
  const next = remove ? stripped : {
    $let: {
      vars: { stripped },
      in: {
        $cond: [
          { $in: [emoji, { $map: { input: '$$stripped', as: 's', in: '$$s.emoji' } }] },
          { $map: {
            input: '$$stripped',
            as: 'r',
            in: {
              emoji: '$$r.emoji',
              userIds: { $cond: [{ $eq: ['$$r.emoji', emoji] }, { $concatArrays: ['$$r.userIds', [uid]] }, '$$r.userIds'] },
            },
          } },
          { $concatArrays: ['$$stripped', [{ emoji, userIds: [uid] }]] },
        ],
      },
    },
  };
  const updated = await SportsMessage.findOneAndUpdate(
    { _id: messageId, sessionId: session._id, deletedAt: null },
    [{ $set: { reactions: { $filter: { input: next, as: 'r', cond: { $gt: [{ $size: '$$r.userIds' }, 0] } } } } }],
    { new: true },
  ).select('reactions').lean();
  // Deleted between the check and the update.
  if (!updated) return messageDeleted();

  sportsSocket().emitSportsReaction(String(plan._id), {
    sessionId: String(session._id),
    messageId: String(messageId),
    reactions: (updated.reactions || [])
      .filter(r => r.userIds && r.userIds.length > 0)
      .map(r => ({ emoji: r.emoji, count: r.userIds.length, userIds: r.userIds.map(String) })),
  });
  return {
    success:   true,
    status:    200,
    messageId: String(messageId),
    reactions: serializeReactions(updated.reactions, user._id),
  };
}

// ── System messages (membership changes, the attendance check) ────────────────

/**
 * Writes "<name> joined the session" and friends. Only ever called after the
 * change really happened; [key] makes a second call for the same change a no-op
 * (unique index), so a retried request cannot announce twice. A join counts as
 * activity; nothing else does — not a leave, a removal, a cancellation, or any
 * part of the attendance check.
 * [extra]: pollId (attendance messages) and previewText (the Messages line for
 * them — server wording with no names in it).
 * @returns the saved message, or null when it had already been announced.
 */
async function announce(session, plan, event, subjectUserId, key, extra = {}) {
  const createdAt = new Date();
  let saved;
  try {
    saved = await new SportsMessage({
      sessionId:     session._id,
      sportsPlanId:  plan._id,
      messageType:   'SYSTEM',
      systemEvent:   event,
      subjectUserId: subjectUserId || null,
      systemKey:     key,
      pollId:        extra.pollId || null,
      createdAt,
      updatedAt:     createdAt,
    }).save({ timestamps: false });
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
  const preview = previewOf(saved);
  if (extra.previewText) preview.text = String(extra.previewText).slice(0, PREVIEW_MAX);
  await recordMessage(session, plan, preview, createdAt.getTime(),
    { qualifies: event === 'MEMBER_JOINED', conditional: false });

  const doc = saved.toObject();
  const message = formatMessage(doc, await hydrate([doc], { plan }));
  sportsSocket().emitSportsMessage(String(plan._id), message, subjectUserId);
  return saved;
}

// ── Notifications (FCM) ───────────────────────────────────────────────────────

// The app's push switch is saved as notifications.pushNotifications (see
// controllers/settingsController.js); there is no top-level field of that name.
const pushesOff = u => !!u && !!u.notifications && u.notifications.pushNotifications === false;

const blockedEitherWay = (a, b) => !!a && !!b && (
  (a.blockedUsers || []).some(id => same(id, b._id)) || (b.blockedUsers || []).some(id => same(id, a._id))
);

/**
 * "Arjun joined your Basketball session" — to everyone already in the plan, never
 * to the joiner. Skips anyone inactive, suspended, with pushes off, or in a block
 * pair with the joiner. A leave-and-rejoin within 30 minutes is not announced
 * twice. Data-only FCM through the existing helper; an older app shows it as a
 * plain notification from `title` / `body`. Always resolves: a notification can
 * never affect the join.
 */
async function notifyMemberJoined(plan, session, joinerId) {
  const summary = { event: 'sports_join_notification', sessionId: String(session._id), considered: 0, sent: 0, skipped: {} };
  const skip = r => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; };
  try {
    const recipients = (plan.playersJoined || []).map(String).filter(id => !same(id, joinerId));
    summary.considered = recipients.length;
    if (recipients.length === 0) return summary;

    const cooldownKey = `sports_join_notification:${session._id}:${joinerId}`;
    if (await redisService.get(cooldownKey)) { skip('cooldown'); return summary; }

    const users = await User.find({ _id: { $in: [...recipients, String(joinerId)] } })
      .select('_id firstName status suspensionInfo notifications.pushNotifications fcmDevices fcmTokens blockedUsers')
      .lean();
    const byId = new Map(users.map(u => [String(u._id), u]));
    const joiner = byId.get(String(joinerId));
    const name = (joiner && joiner.firstName) || 'Someone';
    const sport = sportName(plan);

    for (const uid of recipients) {
      const u = byId.get(uid);
      if (!u) { skip('user_missing'); continue; }
      if (u.status && u.status !== 'ACTIVE') { skip('not_active'); continue; }
      if (u.suspensionInfo && u.suspensionInfo.isSuspended === true) { skip('suspended'); continue; }
      if (pushesOff(u)) { skip('push_disabled'); continue; }
      if (blockedEitherWay(u, joiner)) { skip('blocked_pair'); continue; }
      const tokens = [...new Set([
        ...(u.fcmDevices || []).map(d => d && d.token),
        ...(u.fcmTokens || []),
      ].filter(t => typeof t === 'string' && t.trim()))];
      if (tokens.length === 0) { skip('no_device'); continue; }

      const body = same(uid, plan.creatorId)
        ? `${name} joined your ${sport} session`
        : `${name} joined the ${sport} session`;
      const res = await fcm().sendDataFcm(uid, tokens, {
        type:            'SPORTS_SESSION_JOINED',
        sessionId:       String(session._id),
        sportsPlanId:    String(plan._id),
        sportType:       plan.sportType,
        recipientUserId: uid,
        title:           `${sport} session`,
        body,
      });
      if (res && res.delivered) summary.sent++;
      else skip('fcm_failed');
    }
    if (summary.sent > 0) await redisService.set(cooldownKey, '1', JOIN_NOTIFY_COOLDOWN_SECONDS);
  } catch (err) {
    summary.error = err.message;
    console.error('[SPORTS_JOIN_NOTIFY] failed:', err.message);
  }
  // Counts and ids only — never names, tokens or message text.
  console.log('[SPORTS_JOIN_NOTIFY]', JSON.stringify(summary));
  return summary;
}

/**
 * A Sports push to some of a plan's members (the attendance check and its
 * result), under the same rules as the join notification: skips anyone no longer
 * in the plan, inactive, suspended, with pushes off, or in a block pair with the
 * host (they cannot see the session). [build](userId) gives { type, title, body }.
 * Data-only through the existing helper; quiet hours and the on-screen check are
 * applied by the app. Always resolves.
 */
async function notifyMembers(plan, session, recipientIds, build, label) {
  const summary = { event: label, sessionId: String(session._id), considered: 0, sent: 0, skipped: {} };
  const skip = r => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; };
  try {
    const members = new Set((plan.playersJoined || []).map(String));
    const recipients = [...new Set((recipientIds || []).map(String))];
    summary.considered = recipients.length;
    if (recipients.length === 0) return summary;
    const users = await User.find({ _id: { $in: [...recipients, String(plan.creatorId)] } })
      .select('_id status suspensionInfo notifications.pushNotifications fcmDevices fcmTokens blockedUsers')
      .lean();
    const byId = new Map(users.map(u => [String(u._id), u]));
    const host = byId.get(String(plan.creatorId));
    for (const uid of recipients) {
      const u = byId.get(uid);
      if (!members.has(uid)) { skip('not_a_member'); continue; }
      if (!u) { skip('user_missing'); continue; }
      if (u.status && u.status !== 'ACTIVE') { skip('not_active'); continue; }
      if (u.suspensionInfo && u.suspensionInfo.isSuspended === true) { skip('suspended'); continue; }
      if (pushesOff(u)) { skip('push_disabled'); continue; }
      if (!same(uid, plan.creatorId) && blockedEitherWay(u, host)) { skip('blocked_pair'); continue; }
      const tokens = [...new Set([
        ...(u.fcmDevices || []).map(d => d && d.token),
        ...(u.fcmTokens || []),
      ].filter(t => typeof t === 'string' && t.trim()))];
      if (tokens.length === 0) { skip('no_device'); continue; }
      const note = build(uid);
      const res = await fcm().sendDataFcm(uid, tokens, {
        ...note,
        sessionId:       String(session._id),
        sportsPlanId:    String(plan._id),
        sportType:       plan.sportType,
        recipientUserId: uid,
      });
      if (res && res.delivered) summary.sent++;
      else skip('fcm_failed');
    }
  } catch (err) {
    summary.error = err.message;
    console.error(`[SPORTS_NOTIFY] ${label} failed:`, err.message);
  }
  // Counts and ids only — never names, tokens or message text.
  console.log('[SPORTS_NOTIFY]', JSON.stringify(summary));
  return summary;
}

module.exports = {
  listMessages,
  sendMessage,
  markRead,
  setReaction,
  editMessage,
  deleteForEveryone,
  hideMessage,
  checkMessageLink,
  // For sportsSessionService / sportsAttendanceService (membership hooks, session
  // and list responses, the attendance check).
  announce,
  notifyMemberJoined,
  notifyMembers,
  chatInfo,
  chatStateOf,
  expiresAtOf,
  persistExpiryIfDue,
  loadForMember,
  readOnlyRefusal,
  formatPreview,
  formatPoll,
  pollOpenText,
  pollResultText,
  sportName,
  unreadCounts,
  usersFor,
  // For the socket (typing is allowed only in an open chat) and tests.
  _internal: {
    INACTIVITY_MS, PAGE_DEFAULT, PAGE_MAX, TEXT_MAX, EDIT_WINDOW_MS, RANGE_MAX,
    cleanText, systemText, recordMessage, previewOf, hydrate, formatMessage,
  },
};
