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
// -----------------------------------------------------------------------------
'use strict';

const mongoose            = require('mongoose');
const SportsPlan          = require('../models/SportsPlan');
const SportsSession       = require('../models/SportsSession');
const SportsSessionMember = require('../models/SportsSessionMember');
const SportsMessage       = require('../models/SportsMessage');
const User                = require('../models/User');
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

const fail = (status, code, message, extra = {}) => ({ success: false, status, code, message, ...extra });
const notFound = () => fail(404, 'SESSION_NOT_FOUND', 'This session does not exist or is no longer available.');
const chatClosed = () => fail(403, 'CHAT_CLOSED', 'This sports session was cancelled, so its chat is read-only.');
const chatExpired = () => fail(403, 'CHAT_EXPIRED', 'This chat expired after 7 days without messages.');
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
    messageType:   m.messageType,
    text:          isText ? String(m.text).slice(0, PREVIEW_MAX) : null,
    senderId:      isText ? new ObjectId(String(m.senderId)) : null,
    systemEvent:   isText ? null : m.systemEvent,
    subjectUserId: !isText && m.subjectUserId ? new ObjectId(String(m.subjectUserId)) : null,
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
      { sportsPlanId: String(plan._id) }) };
  }
  return { session, plan };
}

// ── What a message looks like to the app ──────────────────────────────────────

const lite = u => ({ id: String(u._id), firstName: u.firstName || 'Someone', profilePhoto: u.profilePhoto || null });

function systemText(event, name) {
  const who = name || 'Someone';
  switch (event) {
    case 'MEMBER_JOINED':     return `${who} joined the session`;
    case 'MEMBER_LEFT':       return `${who} left the session`;
    case 'SESSION_CANCELLED': return 'Sports session cancelled by the host';
    default:                  return 'Session updated';
  }
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

function formatMessage(m, usersById, viewerId) {
  const isText  = m.messageType === 'TEXT';
  const sender  = isText ? usersById.get(String(m.senderId)) : null;
  const subject = !isText && m.subjectUserId ? usersById.get(String(m.subjectUserId)) : null;
  return {
    id:              String(m._id),
    sessionId:       String(m.sessionId),
    type:            m.messageType,
    text:            isText ? m.text : systemText(m.systemEvent, subject && subject.firstName),
    sender:          isText ? (sender ? lite(sender) : { id: String(m.senderId), firstName: 'Someone', profilePhoto: null }) : null,
    systemEvent:     isText ? null : (m.systemEvent || null),
    subjectUserId:   !isText && m.subjectUserId ? String(m.subjectUserId) : null,
    clientMessageId: m.clientMessageId || null,
    reactions:       serializeReactions(m.reactions, viewerId),
    createdAt:       iso(m.createdAt),
  };
}

/** The Messages → Sessions preview line, or null (no messages, or from someone hidden). */
function formatPreview(session, usersById, hidden = new Set()) {
  const lm = session.lastMessage;
  if (!lm) return null;
  const isText = lm.messageType === 'TEXT';
  const who = isText ? lm.senderId : lm.subjectUserId;
  if (who && hidden.has(String(who))) return null;
  const person = who ? usersById.get(String(who)) : null;
  return {
    type:            lm.messageType,
    text:            isText ? lm.text : systemText(lm.systemEvent, person && person.firstName),
    senderId:        isText && lm.senderId ? String(lm.senderId) : null,
    senderFirstName: isText ? ((person && person.firstName) || 'Someone') : null,
    systemEvent:     isText ? null : lm.systemEvent,
    createdAt:       iso(lm.createdAt),
  };
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

/**
 * GET /sessions/:sessionId/messages?before=<messageId>&limit=<n>
 * Newest first, at most 50 per page, cursor = the oldest message already shown.
 * Readable in every chat state: an expired or cancelled chat keeps its history.
 */
async function listMessages(user, sessionId, query = {}) {
  const access = await loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session } = access;

  const limit  = clampLimit(query.limit);
  const filter = { sessionId: session._id };
  const hidden = await planService()._internal.blockedCounterparts(user);
  if (hidden.length) {
    filter.senderId      = { $nin: hidden };
    filter.subjectUserId = { $nin: hidden };
  }
  if (query.before !== undefined && query.before !== '') {
    if (!isValidId(String(query.before))) return fail(422, 'INVALID_CURSOR', 'That page of messages is not available.');
    const cursor = await SportsMessage.findOne({ _id: query.before, sessionId: session._id }).select('createdAt').lean();
    if (!cursor) return fail(422, 'INVALID_CURSOR', 'That page of messages is not available.');
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
    ];
  }

  const rows = await SportsMessage.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const users = await usersFor(page, [user]);
  return {
    success:    true,
    status:     200,
    messages:   page.map(m => formatMessage(m, users, user._id)),
    hasMore,
    nextBefore: hasMore ? String(page[page.length - 1]._id) : null,
  };
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
  const state = chatStateOf(session, plan, now);
  if (state === 'cancelled') return chatClosed();
  if (state === 'expired') {
    await persistExpiryIfDue(session, plan, now);
    return chatExpired();
  }
  if ((plan.playersJoined || []).length < 2) {
    return fail(409, 'WAITING_FOR_PLAYERS', 'You can chat once someone else joins.');
  }
  return null;
}

/**
 * POST /sessions/:sessionId/messages  { text, clientMessageId? }
 * The sender is the authenticated caller — nothing in the body can change that.
 * A retry with the same clientMessageId returns the message already saved.
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
  const me = new Map([[String(user._id), user]]);

  const duplicate = async () => {
    const existing = await SportsMessage.findOne({ sessionId: session._id, senderId: user._id, clientMessageId }).lean();
    return existing ? { success: true, status: 200, duplicate: true, message: formatMessage(existing, me, user._id) } : null;
  };
  if (clientMessageId) {
    const again = await duplicate();
    if (again) return again;
  }

  const now = Date.now();
  const refusal = await sendRefusal(session, plan, now);
  if (refusal) return refusal;

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

  const message = formatMessage(saved.toObject(), me, user._id);
  sportsSocket().emitSportsMessage(String(plan._id), message, user._id);
  return { success: true, status: 201, message };
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
  const now = Date.now();
  const state = chatStateOf(session, plan, now);
  if (state === 'cancelled') return chatClosed();
  if (state === 'expired') {
    await persistExpiryIfDue(session, plan, now);
    return chatExpired();
  }

  const message = await SportsMessage.findOne({ _id: messageId, sessionId: session._id })
    .select('messageType senderId').lean();
  const hidden = new Set((await planService()._internal.blockedCounterparts(user)).map(String));
  if (!message || (message.senderId && hidden.has(String(message.senderId)))) {
    return fail(404, 'MESSAGE_NOT_FOUND', 'That message is not in this chat.');
  }
  if (message.messageType !== 'TEXT') return fail(422, 'CANNOT_REACT', 'Updates in the chat cannot have reactions.');

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
    { _id: messageId, sessionId: session._id },
    [{ $set: { reactions: { $filter: { input: next, as: 'r', cond: { $gt: [{ $size: '$$r.userIds' }, 0] } } } } }],
    { new: true },
  ).select('reactions').lean();
  if (!updated) return fail(404, 'MESSAGE_NOT_FOUND', 'That message is not in this chat.');

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

// ── System messages (membership changes) ──────────────────────────────────────

/**
 * Writes "<name> joined the session" and friends. Only ever called after the
 * change really happened; [key] makes a second call for the same change a no-op
 * (unique index), so a retried request cannot announce twice. A join counts as
 * activity; a leave or a cancellation does not.
 * @returns the saved message, or null when it had already been announced.
 */
async function announce(session, plan, event, subjectUserId, key) {
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
      createdAt,
      updatedAt:     createdAt,
    }).save({ timestamps: false });
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
  await recordMessage(session, plan, previewOf(saved), createdAt.getTime(),
    { qualifies: event === 'MEMBER_JOINED', conditional: false });

  const users = await usersFor([saved]);
  sportsSocket().emitSportsMessage(String(plan._id), formatMessage(saved.toObject(), users, null), subjectUserId);
  return saved;
}

// ── Join notification (FCM) ───────────────────────────────────────────────────

const sportName = plan => {
  const raw = plan.customSportName || plan.sportType || 'Sports';
  return String(raw).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

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
      .select('_id firstName status suspensionInfo pushNotifications fcmDevices fcmTokens blockedUsers')
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
      if (u.pushNotifications === false) { skip('push_disabled'); continue; }
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

module.exports = {
  listMessages,
  sendMessage,
  markRead,
  setReaction,
  // For sportsSessionService (membership hooks, session and list responses).
  announce,
  notifyMemberJoined,
  chatInfo,
  chatStateOf,
  expiresAtOf,
  persistExpiryIfDue,
  formatPreview,
  unreadCounts,
  usersFor,
  // For the socket (typing is allowed only in an open chat) and tests.
  _internal: { INACTIVITY_MS, PAGE_DEFAULT, PAGE_MAX, TEXT_MAX, cleanText, systemText, recordMessage, previewOf },
};
