// services/roomChatService.js
// -----------------------------------------------------------------------------
// Rooms Phase 3.1: the chat rules Sports Chat has, for Humrah Rooms. Online only.
//
//   history         newest first in pages (before cursor), oldest-first in the reply as
//                   before; hides messages from anyone in a block pair with the reader
//                   and messages the reader deleted for themselves
//   reply           a TEXT message in the same Room, not deleted, not from a block pair
//   edit            author only, TEXT only, within 15 minutes, Room open
//   delete          for everyone: the author ('USER') or the host of a user Room ('HOST');
//                   the text is kept for moderation, never returned
//   delete for me   RoomHiddenMessage; only the caller stops seeing it
//   link check      utils/linkSafety.js, only for a link that is in a visible message
//   members         JOINED members only; first name, photo, role, online. No last name,
//                   no contact details, nobody in a block pair with the caller
//   remove member   host of a user Room only; the existing KICKED status
//
// Every rule is decided here, on the server, from the database. Nothing a client sends
// can choose the sender, the author, the host or the Room.
//
// Compatibility: every field below is additive. Older apps read only the fields they
// knew (content, senderName, reactions, ...). A message deleted for everyone carries a
// placeholder `content`, so an older app shows "This message was deleted" too.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const RoomMessage = require('../models/RoomMessage');
const RoomHiddenMessage = require('../models/RoomHiddenMessage');
const User = require('../models/User');
const redisService = require('./redisService');
const linkSafety = require('../utils/linkSafety');
const { serializeReactions } = require('../utils/roomReactionConfig');
const { recountRoomMembers, emitMembershipChanged, leaveSocketChannel } = require('./roomMembershipService');

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const TEXT_MAX = 1000;
const QUOTE_MAX = 140;
const PAGE_DEFAULT = 100;     // no limit given = the pre-3.1 behaviour (newest 100)
const PAGE_MAX = 100;
const DELETED_TEXT = { USER: 'This message was deleted', HOST: 'This message was removed by the host' };

const { ObjectId } = mongoose.Types;
const isId = (v) => typeof v === 'string' && ObjectId.isValid(v) && String(new ObjectId(v)) === v.toLowerCase();
const same = (a, b) => a != null && b != null && String(a) === String(b);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const fail = (status, code, message) => ({ success: false, status, code, message });

/** Ids of everyone in a block pair with this user, either direction. */
async function blockedSetFor(userId) {
  const [me, them] = await Promise.all([
    User.findById(userId).select('blockedUsers').lean(),
    User.find({ blockedUsers: userId }).select('_id').lean(),
  ]);
  const out = new Set((me?.blockedUsers || []).map(String));
  them.forEach(u => out.add(String(u._id)));
  return out;
}

/** The caller's JOINED membership and the Room, or a refusal. */
async function loadForMember(userId, roomId) {
  if (!isId(String(roomId))) return { error: fail(400, 'INVALID_ROOM', 'Invalid room id') };
  const member = await RoomMember.findOne({ roomId, userId, status: 'JOINED' }).select('role').lean();
  if (!member) return { error: fail(403, 'NOT_A_MEMBER', 'Not a member') };
  const room = await HumrahRoom.findById(roomId).select('status creationSource createdBy capacity memberCount').lean();
  if (!room) return { error: fail(404, 'ROOM_NOT_FOUND', 'Room not found') };
  return { member, room };
}

const isOpen = (room) => !['INACTIVE', 'CLOSED'].includes(room.status);
const roomClosed = () => fail(409, 'ROOM_CLOSED', 'Room is closed or inactive');

/** The host of a USER Room is its creator. Humrah-hosted and system Rooms have none. */
const isHostOf = (room, userId) => room.creationSource === 'USER' && same(room.createdBy, userId);

function cleanContent(raw) {
  if (typeof raw !== 'string') return { error: 'Write a message first.' };
  const text = raw.trim();
  if (!text) return { error: 'Write a message first.' };
  if (text.length > TEXT_MAX) return { error: `Message too long (max ${TEXT_MAX} characters)` };
  return { text };
}

const firstNameOf = (u) => (u && typeof u.firstName === 'string' && u.firstName.trim()) || 'Member';
const fullNameOf = (u) => (u ? (`${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Member') : 'Member');

// ── formatting ───────────────────────────────────────────────────────────────

/**
 * What a reply's quote shows THIS viewer.
 * state: NORMAL | DELETED | HIDDEN (the viewer deleted it for themselves) | UNAVAILABLE
 */
function quoteFor(targetId, ctx) {
  if (!targetId) return null;
  const t = ctx.targets.get(String(targetId));
  const base = { messageId: String(targetId), senderId: null, senderName: null, text: null, state: 'UNAVAILABLE' };
  if (!t) return base;
  const out = { ...base, senderId: t.senderId ? String(t.senderId) : null };
  if (ctx.blocked.has(String(t.senderId))) return out;                       // never name a blocked person
  out.senderName = same(t.senderId, ctx.viewerId) ? 'You' : firstNameOf(ctx.users.get(String(t.senderId)));
  if (t.deletedAt) return { ...out, state: 'DELETED' };
  if (ctx.hiddenForViewer.has(String(t._id))) return { ...out, state: 'HIDDEN' };
  return { ...out, text: String(t.content || '').slice(0, QUOTE_MAX), state: 'NORMAL' };
}

/** One message as the API returns it. The pre-3.1 fields come first, unchanged. */
function formatMessage(m, ctx) {
  const sender = m.senderId ? ctx.users.get(String(m.senderId)) : null;
  const deleted = Boolean(m.deletedAt);
  const isText = m.messageType === 'TEXT';
  return {
    _id: String(m._id),
    roomId: String(m.roomId),
    senderId: m.senderId ? String(m.senderId) : null,
    senderName: ctx.senderNameOverride && same(m.senderId, ctx.viewerSenderId) ? ctx.senderNameOverride : fullNameOf(sender),
    messageType: m.messageType,
    content: deleted ? DELETED_TEXT[m.deletionType] || DELETED_TEXT.USER : m.content,
    clientMessageId: m.clientMessageId || null,
    reactions: deleted ? [] : serializeReactions(m.reactions, ctx.viewerId),
    createdAt: iso(m.createdAt),
    // ── Phase 3.1, additive ──
    senderPhoto: sender?.profilePhoto || null,
    replyTo: deleted ? null : quoteFor(m.replyToId, ctx),
    editedAt: deleted ? null : iso(m.editedAt),
    editableUntil: isText && !deleted && same(m.senderId, ctx.viewerId)
      ? iso(new Date(m.createdAt).getTime() + EDIT_WINDOW_MS) : null,
    deleted,
    deletionType: deleted ? (m.deletionType || 'USER') : null,
  };
}

/** Everything formatMessage needs for a set of messages and one viewer, in 3 queries. */
async function buildContext(messages, { viewerId, blocked }) {
  const replyIds = [...new Set(messages.map(m => m.replyToId).filter(Boolean).map(String))];
  const targets = replyIds.length
    ? await RoomMessage.find({ _id: { $in: replyIds } }).select('senderId content deletedAt roomId').lean()
    : [];
  const userIds = new Set();
  messages.forEach(m => m.senderId && userIds.add(String(m.senderId)));
  targets.forEach(t => t.senderId && userIds.add(String(t.senderId)));
  const [users, hidden] = await Promise.all([
    userIds.size ? User.find({ _id: { $in: [...userIds] } }).select('firstName lastName profilePhoto').lean() : [],
    replyIds.length && viewerId
      ? RoomHiddenMessage.find({ userId: viewerId, messageId: { $in: replyIds } }).select('messageId').lean()
      : [],
  ]);
  return {
    viewerId: viewerId ? String(viewerId) : null,
    blocked: blocked || new Set(),
    users: new Map(users.map(u => [String(u._id), u])),
    targets: new Map(targets.map(t => [String(t._id), t])),
    hiddenForViewer: new Set(hidden.map(h => String(h.messageId))),
  };
}

// ── history ──────────────────────────────────────────────────────────────────

/**
 * GET /api/rooms/:roomId/messages[?before=<messageId>&limit=<1..100>]
 * Without parameters: the newest 100, oldest first — exactly the pre-3.1 reply plus
 * additive fields (hasMore, nextBefore, scanned).
 */
async function listMessages(userId, roomId, query = {}) {
  const access = await loadForMember(userId, roomId);
  if (access.error) return access.error;

  let limit = PAGE_DEFAULT;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX) return fail(422, 'INVALID_LIMIT', 'Invalid limit');
    limit = n;
  }
  const blocked = await blockedSetFor(userId);
  const and = [{ roomId: new ObjectId(String(roomId)) }];
  if (blocked.size) and.push({ senderId: { $nin: [...blocked].map(id => new ObjectId(id)) } });
  if (query.before !== undefined && query.before !== '') {
    const before = String(query.before);
    const cursor = isId(before) ? await RoomMessage.findOne({ _id: before, roomId }).select('createdAt').lean() : null;
    if (!cursor) return fail(422, 'INVALID_CURSOR', 'That page of messages is not available.');
    and.push({ $or: [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
    ] });
  }

  const rows = await RoomMessage.find(and.length === 1 ? and[0] : { $and: and })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  let page = hasMore ? rows.slice(0, limit) : rows;
  const scanned = page.length;
  const nextBefore = hasMore ? String(page[page.length - 1]._id) : null;
  if (page.length) {
    const hiddenRows = await RoomHiddenMessage.find({ userId, messageId: { $in: page.map(m => m._id) } }).select('messageId').lean();
    if (hiddenRows.length) {
      const gone = new Set(hiddenRows.map(h => String(h.messageId)));
      page = page.filter(m => !gone.has(String(m._id)));
    }
  }
  const ctx = await buildContext(page, { viewerId: userId, blocked });
  return {
    success: true,
    status: 200,
    messages: page.reverse().map(m => formatMessage(m, ctx)),   // oldest first, as before
    hasMore,
    nextBefore,
    scanned,
  };
}

// ── reply target (used by the socket send) ───────────────────────────────────

/** null when the message is not a reply; { id } when it may be answered; { error } otherwise. */
async function resolveReplyTarget(userId, roomId, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const notHere = { error: fail(422, 'INVALID_REPLY', 'That message is not in this Room.') };
  if (typeof raw !== 'string' || !isId(raw)) return notHere;
  const target = await RoomMessage.findOne({ _id: raw, roomId }).select('messageType senderId deletedAt').lean();
  if (!target) return notHere;
  if (target.messageType !== 'TEXT') return { error: fail(422, 'INVALID_REPLY', 'Only messages from people can be replied to.') };
  if ((await blockedSetFor(userId)).has(String(target.senderId))) return notHere;
  if (target.deletedAt) return { error: fail(409, 'MESSAGE_DELETED', 'That message was deleted, so it cannot be replied to.') };
  return { id: target._id };
}

// ── socket delivery to each member ───────────────────────────────────────────

/**
 * Emits `event` to every socket in the Room channel, built per viewer. Sockets of anyone
 * in a block pair with `aboutUserId` get nothing. `build(viewerId)` may return null to
 * skip a viewer. Falls back to a plain channel broadcast if sockets can't be listed.
 */
async function emitToRoomViewers(io, roomId, event, build, { aboutUserId = null, exceptSocketId = null } = {}) {
  if (!io) return;
  const channel = `room:${roomId}`;
  let sockets;
  try {
    sockets = await io.in(channel).fetchSockets();
  } catch (err) {
    console.error('[roomChat] fetchSockets failed, plain broadcast:', err.message);
    const payload = await build(null);
    if (payload) io.to(channel).emit(event, payload);
    return;
  }
  const viewers = [...new Set(sockets.map(s => String(s.userId || s.data?.userId || '')).filter(Boolean))];
  let pairBlocked = () => false;
  if (aboutUserId && viewers.length) {
    const docs = await User.find({ _id: { $in: [...viewers, String(aboutUserId)] } }).select('blockedUsers').lean();
    const byId = new Map(docs.map(d => [String(d._id), new Set((d.blockedUsers || []).map(String))]));
    const about = byId.get(String(aboutUserId)) || new Set();
    pairBlocked = (vid) => about.has(vid) || (byId.get(vid) || new Set()).has(String(aboutUserId));
  }
  const cache = new Map();
  for (const s of sockets) {
    if (exceptSocketId && s.id === exceptSocketId) continue;
    const vid = String(s.userId || s.data?.userId || '');
    if (!vid || pairBlocked(vid)) continue;
    if (!cache.has(vid)) cache.set(vid, await build(vid));
    const payload = cache.get(vid);
    if (payload) s.emit(event, payload);
  }
}

/** The broadcast/ack shape for one message, for one viewer (null = anonymous). */
async function formatForViewer(message, viewerId, { senderNameOverride } = {}) {
  const blocked = viewerId ? await blockedSetFor(viewerId) : new Set();
  const ctx = await buildContext([message], { viewerId, blocked });
  ctx.senderNameOverride = senderNameOverride || null;
  ctx.viewerSenderId = message.senderId;
  return formatMessage(message, ctx);
}

// ── edit / delete / hide / link check ────────────────────────────────────────

/** A message in this Room the caller can see (not from a block pair), or a refusal. */
async function visibleMessage(userId, roomId, messageId) {
  if (!isId(String(messageId))) return { error: fail(404, 'MESSAGE_NOT_FOUND', 'Message not found in this room') };
  const m = await RoomMessage.findOne({ _id: messageId, roomId }).lean();
  if (!m) return { error: fail(404, 'MESSAGE_NOT_FOUND', 'Message not found in this room') };
  if (m.senderId && (await blockedSetFor(userId)).has(String(m.senderId))) {
    return { error: fail(404, 'MESSAGE_NOT_FOUND', 'Message not found in this room') };
  }
  return { message: m };
}

const messageDeleted = () => fail(409, 'MESSAGE_DELETED', 'This message was deleted.');

async function editMessage(io, userId, roomId, messageId, body = {}, now = Date.now()) {
  const cleaned = cleanContent(body && body.content);
  if (cleaned.error) return fail(422, 'INVALID_MESSAGE', cleaned.error);
  const access = await loadForMember(userId, roomId);
  if (access.error) return access.error;
  if (!isOpen(access.room)) return roomClosed();
  const found = await visibleMessage(userId, roomId, messageId);
  if (found.error) return found.error;
  const m = found.message;
  if (m.messageType !== 'TEXT') return fail(422, 'CANNOT_EDIT', 'Only your own messages can be edited.');
  if (!same(m.senderId, userId)) return fail(403, 'NOT_MESSAGE_AUTHOR', 'You can only edit your own messages.');
  if (m.deletedAt) return messageDeleted();
  const windowPassed = () => fail(409, 'EDIT_WINDOW_PASSED', 'Messages can only be edited for 15 minutes after sending.');
  if (now - new Date(m.createdAt).getTime() > EDIT_WINDOW_MS) return windowPassed();

  if (m.content === cleaned.text) {
    return { success: true, status: 200, message: await formatForViewer(m, userId) };   // nothing changed: no write, no event
  }
  const at = new Date(now);
  const updated = await RoomMessage.findOneAndUpdate(
    { _id: m._id, roomId, messageType: 'TEXT', senderId: userId, deletedAt: null, createdAt: { $gte: new Date(now - EDIT_WINDOW_MS) } },
    { $set: { content: cleaned.text, editedAt: at } },
    { new: true, timestamps: false },
  ).lean();
  if (!updated) {
    const again = await RoomMessage.findById(m._id).select('deletedAt').lean();
    return again && again.deletedAt ? messageDeleted() : windowPassed();
  }
  emitToRoomViewers(io, roomId, 'room_message_updated', () => ({
    roomId: String(roomId), messageId: String(updated._id), content: updated.content, editedAt: iso(updated.editedAt),
  }), { aboutUserId: userId }).catch(err => console.error('[roomChat] edit emit failed:', err.message));
  return { success: true, status: 200, message: await formatForViewer(updated, userId) };
}

async function deleteForEveryone(io, userId, roomId, messageId, now = Date.now()) {
  const access = await loadForMember(userId, roomId);
  if (access.error) return access.error;
  if (!isOpen(access.room)) return roomClosed();
  const found = await visibleMessage(userId, roomId, messageId);
  if (found.error) return found.error;
  const m = found.message;
  if (m.messageType !== 'TEXT') return fail(422, 'CANNOT_DELETE', 'Only messages from people can be deleted.');
  if (m.deletedAt) return messageDeleted();
  const isAuthor = same(m.senderId, userId);
  const isHost = isHostOf(access.room, userId);
  if (!isAuthor && !isHost) {
    return fail(403, 'NOT_ALLOWED_TO_DELETE', 'Only the person who sent this message, or the host, can delete it for everyone.');
  }
  const deletionType = isAuthor ? 'USER' : 'HOST';
  const at = new Date(now);
  const filter = { _id: m._id, roomId, messageType: 'TEXT', deletedAt: null };
  if (isAuthor) filter.senderId = userId;
  const updated = await RoomMessage.findOneAndUpdate(
    filter,
    { $set: { deletedAt: at, deletedBy: userId, deletionType } },
    { new: true, timestamps: false },
  ).lean();
  if (!updated) return messageDeleted();
  if (deletionType === 'HOST') {
    // Ids only — never the text.
    console.log(`[ROOM_CHAT_MODERATION] host_delete room=${roomId} message=${updated._id} host=${userId} author=${updated.senderId}`);
  }
  emitToRoomViewers(io, roomId, 'room_message_deleted', () => ({
    roomId: String(roomId), messageId: String(updated._id), deletionType, deletedAt: iso(at),
    content: DELETED_TEXT[deletionType],
  })).catch(err => console.error('[roomChat] delete emit failed:', err.message));
  return { success: true, status: 200, message: await formatForViewer(updated, userId) };
}

async function hideMessage(io, userId, roomId, messageId) {
  const access = await loadForMember(userId, roomId);
  if (access.error) return access.error;
  const found = await visibleMessage(userId, roomId, messageId);
  if (found.error) return found.error;
  if (found.message.messageType !== 'TEXT') return fail(422, 'CANNOT_DELETE', 'Only messages from people can be deleted.');
  try {
    await RoomHiddenMessage.updateOne(
      { userId, messageId: found.message._id },
      { $setOnInsert: { userId, roomId, messageId: found.message._id } },
      { upsert: true },
    );
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;   // two at once: already hidden
  }
  try {
    if (io) io.to(`user:${userId}`).emit('room_message_hidden', { roomId: String(roomId), messageId: String(found.message._id) });
  } catch (_) { /* the reply already says it worked */ }
  return { success: true, status: 200, messageId: String(found.message._id), hidden: true };
}

async function checkMessageLink(userId, roomId, messageId, body = {}) {
  const access = await loadForMember(userId, roomId);
  if (access.error) return access.error;
  const found = await visibleMessage(userId, roomId, messageId);
  if (found.error) return found.error;
  const m = found.message;
  if (m.messageType !== 'TEXT' || m.deletedAt) return fail(404, 'MESSAGE_NOT_FOUND', 'Message not found in this room');
  const raw = body && typeof body.url === 'string' ? body.url.trim() : '';
  const parsed = linkSafety.parseWebUrl(raw);
  if (!parsed) return fail(422, 'INVALID_LINK', 'That is not a web link Humrah can open.');
  if (!String(m.content || '').includes(raw)) return fail(422, 'INVALID_LINK', 'That link is not in this message.');
  const result = await linkSafety.checkLink(parsed);
  return {
    success: true, status: 200, url: parsed.href, host: parsed.host, secure: parsed.secure,
    verdict: result.verdict, checkedBy: result.checkedBy, threatTypes: result.threatTypes || [],
  };
}

// ── members ──────────────────────────────────────────────────────────────────

async function listMembers(userId, roomId) {
  const access = await loadForMember(userId, roomId);
  if (access.error) return access.error;
  const { room } = access;
  const rows = await RoomMember.find({ roomId, status: 'JOINED' }).select('userId role joinedAt').sort({ joinedAt: 1 }).limit(200).lean();
  const blocked = await blockedSetFor(userId);
  const visible = rows.filter(r => !blocked.has(String(r.userId)));
  const users = await User.find({ _id: { $in: visible.map(r => r.userId) }, status: 'ACTIVE' })
    .select('firstName profilePhoto').lean();
  const byId = new Map(users.map(u => [String(u._id), u]));
  const presence = await redisService.getMany(visible.map(r => `presence:room:${roomId}:${r.userId}`)).catch(() => new Map());
  const hostId = room.creationSource === 'USER' && room.createdBy ? String(room.createdBy) : null;
  const members = visible
    .filter(r => byId.has(String(r.userId)))
    .map(r => {
      const u = byId.get(String(r.userId));
      const id = String(r.userId);
      return {
        userId: id,
        firstName: firstNameOf(u),
        profilePhoto: u.profilePhoto || null,
        isHost: hostId === id,
        isMe: id === String(userId),
        online: presence.has(`presence:room:${roomId}:${id}`),
        joinedAt: iso(r.joinedAt),
      };
    })
    .sort((a, b) => (b.isHost - a.isHost) || (b.isMe - a.isMe) || (b.online - a.online));
  return {
    success: true, status: 200, roomId: String(roomId),
    memberCount: rows.length, capacity: room.capacity, hostUserId: hostId,
    canManage: hostId === String(userId),
    members,
  };
}

async function removeMember(io, userId, roomId, targetUserId) {
  const access = await loadForMember(userId, roomId);
  if (access.error) return access.error;
  if (!isHostOf(access.room, userId)) return fail(403, 'NOT_HOST', 'Only the host can remove people from this Room.');
  if (!isId(String(targetUserId))) return fail(404, 'NOT_A_MEMBER', 'That person is not in this Room.');
  if (same(targetUserId, userId)) return fail(422, 'CANNOT_REMOVE_SELF', 'Use Leave Room to leave your own Room.');
  const updated = await RoomMember.findOneAndUpdate(
    { roomId, userId: targetUserId, status: 'JOINED' },
    { $set: { status: 'KICKED', leftAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) return fail(404, 'NOT_A_MEMBER', 'That person is not in this Room.');
  leaveSocketChannel(io, targetUserId, roomId);
  try { await redisService.del?.(`presence:room:${roomId}:${targetUserId}`); } catch (_) {}
  const room = await recountRoomMembers(roomId);
  emitMembershipChanged(io, room, 'LEFT');
  try {
    if (io) io.to(`user:${targetUserId}`).emit('room_removed', { roomId: String(roomId) });
  } catch (_) {}
  console.log(`[ROOM_CHAT_MODERATION] member_removed room=${roomId} host=${userId} member=${targetUserId}`);
  return {
    success: true, status: 200,
    memberCount: room ? room.memberCount : null, capacity: room ? room.capacity : null, roomStatus: room ? room.status : null,
  };
}

module.exports = {
  EDIT_WINDOW_MS,
  DELETED_TEXT,
  blockedSetFor,
  isHostOf,
  formatMessage,
  buildContext,
  formatForViewer,
  listMessages,
  resolveReplyTarget,
  emitToRoomViewers,
  editMessage,
  deleteForEveryone,
  hideMessage,
  checkMessageLink,
  listMembers,
  removeMember,
};
