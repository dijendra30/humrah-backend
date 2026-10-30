// services/personChatService.js
// -----------------------------------------------------------------------------
// One-to-one (person-to-person) chat on top of the existing MoodChat document:
// what a message looks like to the person reading it, and the message actions —
// reply, react, edit, delete for me / for everyone, mute. Every rule is decided
// here, on the server; the app only shows what this returns.
//
//   • Only the two people in the chat can read or act on it.
//   • Edit: your own text message, within EDIT_WINDOW_MS, not deleted.
//   • Delete for everyone: your own message; its text is removed for both people
//     (and from any reply that quoted it). Delete for me: hides it for you only.
//   • React: one reaction per person per message, from REACTIONS; the same emoji
//     again removes it, a different one replaces it.
//   • Nothing can be sent or changed while either person has blocked the other,
//     while either has left the conversation, or if the chat was switched off.
//   • One-to-one chats do NOT expire: age never closes or hides them.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const MoodChat = require('../models/MoodChat');
const User     = require('../models/User');

const EDIT_WINDOW_MS = 15 * 60 * 1000;           // same window as Movie Hangout chat
const REACTIONS      = ['❤️', '😂', '👍', '😮', '😢', '🔥'];
const DELETED_TEXT   = 'This message was deleted';
const MAX_TEXT       = 500;                      // MoodChat schema maxlength
const EXCERPT        = 160;

const idOf = v => (v && v._id ? v._id : v)?.toString();
const fail = (status, code, message) => ({ ok: false, status, code, message });

/** True when either person has blocked the other (User.blockedUsers, as everywhere else). */
async function blockedBetween(a, b) {
  const users = await User.find({ _id: { $in: [a, b] } }, 'blockedUsers').lean();
  const of = id => users.find(u => idOf(u) === idOf(id));
  const has = (u, other) => (u?.blockedUsers || []).some(x => idOf(x) === idOf(other));
  return {
    byA: has(of(a), b),   // a blocked b
    byB: has(of(b), a),   // b blocked a
    any: has(of(a), b) || has(of(b), a),
  };
}

// One-to-one chats never expire; only an explicit switch-off (active: false) closes one.
// `now` is kept in the signature for the callers, not used.
function isOpen(chat, now = Date.now()) { // eslint-disable-line no-unused-vars
  return chat.active !== false;
}

/** Ids of the people who left this conversation (Leave Conversation). */
function leftIds(chat) {
  return (chat.leftBy || []).map(l => idOf(l.userId));
}

/** The quoted part of a reply, as it reads NOW (an edit shows, a deleted original never does). */
function replyView(m, byId) {
  if (!m.replyTo || !m.replyTo.messageId) return null;
  const target = byId.get(idOf(m.replyTo.messageId));
  const deleted = target ? !!target.deletedForEveryoneAt : !m.replyTo.text;
  return {
    messageId: idOf(m.replyTo.messageId),
    senderId:  idOf(m.replyTo.senderId),
    text:      deleted ? DELETED_TEXT : (target ? target.text : m.replyTo.text || '').slice(0, EXCERPT),
    deleted,
  };
}

/** A message as either person sees it. Never includes who hid it. */
function shapeMessage(m, byId) {
  const deleted = !!m.deletedForEveryoneAt;
  return {
    _id:       idOf(m._id),
    senderId:  idOf(m.senderId),
    // Older apps render `text` as is; they show the placeholder instead of an empty bubble.
    text:      deleted ? DELETED_TEXT : m.text,
    createdAt: m.createdAt,
    editedAt:  deleted ? null : (m.editedAt || null),
    deleted,
    replyTo:   deleted ? null : replyView(m, byId || new Map()),
    reactions: deleted ? [] : (m.reactions || []).map(r => ({ userId: idOf(r.userId), emoji: r.emoji })),
  };
}

function messageMap(chat) {
  return new Map((chat.messages || []).map(m => [idOf(m._id), m]));
}

/**
 * The chat as `viewerId` sees it: messages they hid are left out, deleted ones are
 * placeholders, and the per-person fields (mutedBy, hiddenFor) never leave the server.
 * `block` is the blockedBetween(viewer, peer) result.
 */
function shapeChatFor(chat, viewerId, block, now = Date.now()) {
  const byId = messageMap(chat);
  const me = idOf(viewerId);
  const messages = (chat.messages || [])
    .filter(m => !(m.hiddenFor || []).some(u => idOf(u) === me))
    .map(m => shapeMessage(m, byId));
  const { mutedBy, leftBy, ...rest } = chat;
  const open = isOpen(chat, now);
  const left = leftIds(chat);
  const leftByMe = left.includes(me);
  const peerLeft = left.some(id => id !== me);
  return {
    ...rest,
    // No expiry for one-to-one chats; older documents still carry a date — never show it.
    expiresAt:   null,
    messages,
    mutedByMe:   (mutedBy || []).some(u => idOf(u) === me),
    blockedByMe: !!block?.byA,
    leftByMe,
    peerLeft,
    // One flag for "you can't send here", without saying which side blocked.
    canMessage:  open && !block?.any && left.length === 0,
    closed:      !open,
  };
}

/** Loads the chat for one of its two people (404 for anyone else). */
async function loadForMember(chatRoomId, userId) {
  if (!mongoose.isValidObjectId(chatRoomId)) return { error: fail(404, 'CHAT_NOT_FOUND', 'Chat not found') };
  const chat = await MoodChat.findOne({ _id: chatRoomId, users: userId });
  if (!chat) return { error: fail(404, 'CHAT_NOT_FOUND', 'Chat not found') };
  return { chat };
}

function peerOf(chat, userId) {
  return (chat.users || []).find(u => idOf(u) !== idOf(userId));
}

/** Shared gate for anything that changes the conversation. */
async function writableFor(chatRoomId, userId, now = Date.now()) {
  const { chat, error } = await loadForMember(chatRoomId, userId);
  if (error) return { error };
  if (!isOpen(chat, now)) return { error: fail(409, 'CHAT_CLOSED', 'This chat has closed') };
  const left = leftIds(chat);
  if (left.includes(idOf(userId))) return { error: fail(409, 'LEFT', 'You left this conversation') };
  if (left.length) return { error: fail(409, 'PEER_LEFT', 'This person is no longer in this conversation') };
  const peer = peerOf(chat, userId);
  if (peer && (await blockedBetween(userId, peer)).any) {
    return { error: fail(403, 'BLOCKED', 'You can no longer interact in this chat') };
  }
  return { chat, peer };
}

function findMessage(chat, messageId) {
  if (!mongoose.isValidObjectId(messageId)) return null;
  return chat.messages.id(messageId) || null;
}

function emitUpdate(chat, msg) {
  try {
    const { io } = require('../server');
    io.to(idOf(chat._id)).emit('mood:message-updated', {
      chatId:  idOf(chat._id),
      message: shapeMessage(msg.toObject ? msg.toObject() : msg, messageMap(chat)),
    });
  } catch (_) { /* realtime is best-effort; the next load is authoritative */ }
}

// ── Edit ─────────────────────────────────────────────────────────────────────
async function editMessage(userId, chatRoomId, messageId, text, now = Date.now()) {
  const body = (text || '').trim();
  if (!body) return fail(400, 'TEXT_REQUIRED', 'Message cannot be empty');
  if (body.length > MAX_TEXT) return fail(400, 'TEXT_TOO_LONG', `Messages can be up to ${MAX_TEXT} characters`);
  const { chat, error } = await writableFor(chatRoomId, userId, now);
  if (error) return error;
  const msg = findMessage(chat, messageId);
  if (!msg || (msg.hiddenFor || []).some(u => idOf(u) === idOf(userId))) return fail(404, 'MESSAGE_NOT_FOUND', 'Message not found');
  if (idOf(msg.senderId) !== idOf(userId)) return fail(403, 'NOT_AUTHOR', 'You can only edit your own messages');
  if (msg.deletedForEveryoneAt) return fail(409, 'MESSAGE_DELETED', 'This message was deleted');
  if (now - new Date(msg.createdAt).getTime() > EDIT_WINDOW_MS) {
    return fail(409, 'EDIT_WINDOW_PASSED', 'Messages can only be edited for 15 minutes');
  }
  if (msg.text === body) return { ok: true, status: 200, message: shapeMessage(msg.toObject(), messageMap(chat)) };
  msg.text = body;
  msg.editedAt = new Date(now);
  chat.updatedAt = new Date(now);
  await chat.save();
  emitUpdate(chat, msg);
  return { ok: true, status: 200, message: shapeMessage(msg.toObject(), messageMap(chat)) };
}

// ── Delete ───────────────────────────────────────────────────────────────────
async function deleteMessage(userId, chatRoomId, messageId, scope, now = Date.now()) {
  if (scope !== 'everyone' && scope !== 'me') return fail(400, 'BAD_SCOPE', 'scope must be "me" or "everyone"');
  // Delete for me only hides it from my own view — allowed even after the chat
  // closed or a block, since it changes nothing for the other person.
  const loaded = scope === 'me' ? await loadForMember(chatRoomId, userId) : await writableFor(chatRoomId, userId, now);
  if (loaded.error) return loaded.error;
  const { chat } = loaded;
  const msg = findMessage(chat, messageId);
  if (!msg || (msg.hiddenFor || []).some(u => idOf(u) === idOf(userId))) return fail(404, 'MESSAGE_NOT_FOUND', 'Message not found');

  if (scope === 'me') {
    await MoodChat.updateOne(
      { _id: chat._id, 'messages._id': msg._id },
      { $addToSet: { 'messages.$.hiddenFor': new mongoose.Types.ObjectId(idOf(userId)) } },
    );
    return { ok: true, status: 200, hidden: true, messageId: idOf(msg._id) };
  }

  if (idOf(msg.senderId) !== idOf(userId)) return fail(403, 'NOT_AUTHOR', 'You can only delete your own messages for everyone');
  if (!msg.deletedForEveryoneAt) {
    msg.deletedForEveryoneAt = new Date(now);
    msg.text = '';
    msg.editedAt = null;
    msg.reactions = [];
    // No reply keeps a copy of the words that were deleted.
    for (const m of chat.messages) {
      if (m.replyTo && idOf(m.replyTo.messageId) === idOf(msg._id)) m.replyTo.text = '';
    }
    chat.updatedAt = new Date(now);
    await chat.save();
    emitUpdate(chat, msg);
  }
  return { ok: true, status: 200, message: shapeMessage(msg.toObject(), messageMap(chat)) };
}

// ── React ────────────────────────────────────────────────────────────────────
async function reactToMessage(userId, chatRoomId, messageId, emoji, now = Date.now()) {
  if (!REACTIONS.includes(emoji)) return fail(400, 'BAD_REACTION', 'Unsupported reaction');
  const { chat, error } = await writableFor(chatRoomId, userId, now);
  if (error) return error;
  const msg = findMessage(chat, messageId);
  if (!msg || (msg.hiddenFor || []).some(u => idOf(u) === idOf(userId))) return fail(404, 'MESSAGE_NOT_FOUND', 'Message not found');
  if (msg.deletedForEveryoneAt) return fail(409, 'MESSAGE_DELETED', 'This message was deleted');
  const mine = (msg.reactions || []).find(r => idOf(r.userId) === idOf(userId));
  if (mine && mine.emoji === emoji) {
    msg.reactions = msg.reactions.filter(r => idOf(r.userId) !== idOf(userId));    // toggle off
  } else if (mine) {
    mine.emoji = emoji;                                                             // replace
  } else {
    msg.reactions.push({ userId, emoji });
  }
  await chat.save();
  emitUpdate(chat, msg);
  return { ok: true, status: 200, message: shapeMessage(msg.toObject(), messageMap(chat)) };
}

// ── Mute ─────────────────────────────────────────────────────────────────────
async function setMuted(userId, chatRoomId, muted) {
  const { chat, error } = await loadForMember(chatRoomId, userId);
  if (error) return error;
  const uid = new mongoose.Types.ObjectId(idOf(userId));
  await MoodChat.updateOne({ _id: chat._id }, muted ? { $addToSet: { mutedBy: uid } } : { $pull: { mutedBy: uid } });
  return { ok: true, status: 200, muted: !!muted };
}

// ── Leave Conversation ───────────────────────────────────────────────────────
/**
 * The caller leaves: recorded once (a repeat is harmless), the chat leaves THEIR lists,
 * and nobody can send until an accepted request reopens it. Nothing is deleted, the
 * other person is not blocked or reported, and their copy of the chat stays — it only
 * says they are no longer in it.
 */
async function leaveChat(userId, chatRoomId, now = Date.now()) {
  const { chat, error } = await loadForMember(chatRoomId, userId);
  if (error) return error;
  const uid = new mongoose.Types.ObjectId(idOf(userId));
  const r = await MoodChat.updateOne(
    { _id: chat._id, users: uid, 'leftBy.userId': { $ne: uid } },
    { $push: { leftBy: { userId: uid, at: new Date(now) } }, $set: { updatedAt: new Date(now) } },
  );
  if (r.modifiedCount === 1) {
    try {
      const { io } = require('../server');
      // No who/why beyond what the other screen needs to show its status.
      io.to(idOf(chat._id)).emit('mood:participant-left', { chatId: idOf(chat._id) });
    } catch (_) { /* best-effort; the next load is authoritative */ }
  }
  return { ok: true, status: 200, left: true, alreadyLeft: r.modifiedCount !== 1, chatRoomId: idOf(chat._id) };
}

/** Builds the stored reply reference for a new message (null if the target is gone). */
function replyReference(chat, replyToId, viewerId) {
  if (!replyToId) return null;
  const target = findMessage(chat, replyToId);
  if (!target || target.deletedForEveryoneAt) return null;
  if ((target.hiddenFor || []).some(u => idOf(u) === idOf(viewerId))) return null;
  return { messageId: target._id, senderId: target.senderId, text: (target.text || '').slice(0, EXCERPT) };
}

module.exports = {
  EDIT_WINDOW_MS, REACTIONS, DELETED_TEXT, MAX_TEXT,
  blockedBetween, isOpen, leftIds, shapeMessage, shapeChatFor, messageMap, peerOf,
  editMessage, deleteMessage, reactToMessage, setMuted, replyReference, leaveChat,
};
