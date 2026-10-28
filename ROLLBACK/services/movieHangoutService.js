const mongoose = require('mongoose');
const MovieSession = require('../models/MovieSession');
const MovieMessage = require('../models/MovieMessage');
const User = require('../models/User');

/**
 * Ensures the chat is active and the user is a member.
 */
async function validateAccess(userId, sessionId) {
  const session = await MovieSession.findById(sessionId);
  if (!session) throw new Error('Session not found');

  const isMember = session.participants.some(p => p.toString() === userId.toString());
  if (!isMember) throw new Error('Not a member');

  if (session.status === 'expired') throw new Error('Chat is no longer available');

  return session;
}

/**
 * Handle incoming text message via Socket
 */
async function handleSocketMessage(userId, sessionId, text, replyTo, clientMessageId, io) {
  if (!text?.trim()) throw new Error('Message text required');
  await validateAccess(userId, sessionId);
  replyTo = await _replyTarget(sessionId, replyTo);

  if (clientMessageId) {
    const existingMsg = await MovieMessage.findOne({ clientMessageId, sessionId });
    if (existingMsg) {
      // Idempotency: Return existing message
      return existingMsg;
    }
  }

  const sender = await User.findById(userId).select('firstName lastName profilePhoto').lean();
  const senderName = sender ? `${sender.firstName} ${sender.lastName || ''}`.trim() : 'User';

  const msg = new MovieMessage({
    sessionId,
    senderId: userId,
    senderName,
    senderPhoto: sender?.profilePhoto || null,
    type: 'text',
    text: text.trim(),
    replyTo: replyTo || null,
    clientMessageId: clientMessageId || null,
    readBy: [userId],
  });
  await msg.save();

  _broadcastMessage(io, sessionId, msg);
  _sendFCM(sessionId, msg, senderName, false);
  return msg;
}

/**
 * Handle incoming voice note via Socket
 */
async function handleSocketVoiceNote(userId, sessionId, voiceUrl, duration, replyTo, clientMessageId, io) {
  if (!voiceUrl) throw new Error('Voice URL required');
  
  // Security validation: verify voiceUrl is a valid Firebase Storage URL for the project
  const isValidFirebaseUrl = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/humrah-d926d\.firebasestorage\.app\/o\/voice-notes%2F[a-zA-Z0-9_-]+%2F.+\?alt=media/.test(voiceUrl);
  if (!isValidFirebaseUrl) throw new Error('Invalid or unauthorized voice URL');

  await validateAccess(userId, sessionId);
  replyTo = await _replyTarget(sessionId, replyTo);

  if (clientMessageId) {
    const existingMsg = await MovieMessage.findOne({ clientMessageId, sessionId });
    if (existingMsg) {
      // Idempotency: Return existing message
      return existingMsg;
    }
  }

  const sender = await User.findById(userId).select('firstName lastName profilePhoto').lean();
  const senderName = sender ? `${sender.firstName} ${sender.lastName || ''}`.trim() : 'User';

  const msg = new MovieMessage({
    sessionId,
    senderId: userId,
    senderName,
    senderPhoto: sender?.profilePhoto || null,
    type: 'voice',
    voiceUrl,
    duration,
    replyTo: replyTo || null,
    clientMessageId: clientMessageId || null,
    readBy: [userId],
  });
  await msg.save();

  _broadcastMessage(io, sessionId, msg);
  _sendFCM(sessionId, msg, senderName, true);
  return msg;
}

/**
 * Handle message reaction via Socket
 */
async function handleMessageReaction(userId, sessionId, messageId, reaction, io) {
  if (!['👍', '❤️', '😂', '😮', '😭'].includes(reaction)) throw new Error('Invalid reaction');
  await validateAccess(userId, sessionId);

  if (!mongoose.isValidObjectId(messageId)) throw new Error('Message not found');
  const message = await MovieMessage.findById(messageId);
  if (!message || message.sessionId.toString() !== sessionId.toString()) throw new Error('Message not found');
  if (message.deletedAt) throw new Error('Message not found');

  const existingReactionIndex = message.reactions.findIndex(r => r.userId.toString() === userId.toString());
  
  if (existingReactionIndex > -1) {
    if (message.reactions[existingReactionIndex].reaction === reaction) {
      // Toggle off if same reaction
      message.reactions.splice(existingReactionIndex, 1);
    } else {
      // Change reaction
      message.reactions[existingReactionIndex].reaction = reaction;
    }
  } else {
    // Add new reaction
    message.reactions.push({ userId, reaction });
  }

  await message.save();

  if (io) {
    io.to(`movie:${sessionId}`).emit('messageReaction', {
      messageId,
      reactions: message.reactions.map(r => ({ userId: r.userId.toString(), reaction: r.reaction }))
    });
  }
}

/**
 * Handle message pinning via Socket
 */
async function handlePinMessage(userId, sessionId, messageId, io) {
  const session = await validateAccess(userId, sessionId);

  // In this implementation, any participant can pin.
  // Alternatively, check if userId === session.adminId
  
  // Toggle pin
  if (session.pinnedMessageId?.toString() === messageId.toString()) {
    session.pinnedMessageId = null;
  } else {
    session.pinnedMessageId = messageId;
  }
  await session.save();

  if (io) {
    io.to(`movie:${sessionId}`).emit('messagePinned', {
      pinnedMessageId: session.pinnedMessageId?.toString() || null
    });
  }
}

/**
 * Handle rating poll vote
 */
async function handlePollVote(userId, sessionId, rating, io) {
  if (rating < 1 || rating > 5) throw new Error('Invalid rating');
  const session = await validateAccess(userId, sessionId);

  const existingVoteIndex = session.ratings.findIndex(r => r.userId.toString() === userId.toString());
  if (existingVoteIndex > -1) {
    session.ratings[existingVoteIndex].rating = rating;
  } else {
    session.ratings.push({ userId, rating });
  }
  
  await session.save();

  // Optionally calculate average and broadcast
  const total = session.ratings.reduce((acc, r) => acc + r.rating, 0);
  const average = total / session.ratings.length;

  if (io) {
    io.to(`movie:${sessionId}`).emit('pollUpdated', {
      averageRating: average.toFixed(1),
      totalVotes: session.ratings.length,
      ratings: session.ratings.map(r => ({ userId: r.userId.toString(), rating: r.rating }))
    });
  }
}

/**
 * Handle marking messages as read
 */
async function handleMarkRead(userId, sessionId, messageIds) {
  // We just add userId to readBy arrays of all these messages
  await MovieMessage.updateMany(
    { _id: { $in: messageIds }, sessionId },
    { $addToSet: { readBy: userId } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const EDIT_WINDOW_MS = 15 * 60 * 1000;   // the same 15 minutes Sports chat allows
const PREVIEW_MAX    = 120;
const TEXT_MAX       = 1000;

/** A reply must point at a message of the same session; anything else is dropped (never an error). */
async function _replyTarget(sessionId, replyTo) {
  if (!replyTo || !mongoose.isValidObjectId(replyTo)) return null;
  const t = await MovieMessage.findOne({ _id: replyTo, sessionId }).select('_id').lean();
  return t ? t._id : null;
}

/** The quoted message as a reply shows it — resolved when read, so it follows edits and never shows deleted text. */
function _replyPreview(target) {
  if (!target) return { unavailable: true };
  const deleted = !!target.deletedAt;
  return {
    messageId:  target._id.toString(),
    senderId:   target.senderId?.toString() || null,
    senderName: target.senderName || 'Someone',
    type:       target.type,
    text:       deleted || target.type !== 'text' ? '' : String(target.text || '').slice(0, PREVIEW_MAX),
    deleted,
    unavailable: false,
  };
}

/**
 * One message as every client receives it (socket broadcast, edit/delete events and
 * history all use this). A deleted message keeps only its place: no text, no voice
 * URL, no reactions, no quote.
 */
function formatMovieMessage(msg, replyTargets = new Map()) {
  const m = msg.toObject ? msg.toObject() : msg;
  const deleted = !!m.deletedAt;
  const replyId = m.replyTo ? m.replyTo.toString() : null;
  return {
    id:              m._id.toString(),
    senderId:        m.senderId?.toString() || null,
    senderName:      m.senderName,
    senderPhoto:     m.senderPhoto || null,
    type:            m.type,
    text:            deleted ? '' : (m.text || ''),
    voiceUrl:        deleted ? null : (m.voiceUrl || null),
    duration:        m.duration || 0,
    replyTo:         deleted ? null : replyId,
    replyPreview:    !deleted && replyId ? _replyPreview(replyTargets.get(replyId)) : null,
    clientMessageId: m.clientMessageId || null,
    readBy:          (m.readBy || []).map(r => r.toString()),
    reactions:       deleted ? [] : (m.reactions || []).map(r => ({ userId: r.userId?.toString(), reaction: r.reaction })),
    isSystem:        m.type === 'system',
    editedAt:        deleted || !m.editedAt ? null : new Date(m.editedAt).toISOString(),
    deleted,
    timestamp:       new Date(m.createdAt).toISOString(),
  };
}

/** Loads every message the given ones quote, in one query. */
async function loadReplyTargets(messages) {
  const ids = [...new Set(messages.map(m => m.replyTo && m.replyTo.toString()).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await MovieMessage.find({ _id: { $in: ids } }).select('senderId senderName type text deletedAt').lean();
  return new Map(rows.map(r => [r._id.toString(), r]));
}

async function _broadcastMessage(io, sessionId, msg) {
  if (!io) return;
  console.log(`Broadcasting message ${msg._id} to room: movie:${sessionId}`);
  const targets = await loadReplyTargets([msg]).catch(() => new Map());
  io.to(`movie:${sessionId}`).emit('movieMessageReceived', formatMovieMessage(msg, targets));
}

async function _broadcastUpdate(io, sessionId, msg) {
  if (!io) return;
  const targets = await loadReplyTargets([msg]).catch(() => new Map());
  io.to(`movie:${sessionId}`).emit('movieMessageUpdated', formatMovieMessage(msg, targets));
}

function _fail(status, code, message) { return { success: false, status, code, message }; }

/** Membership + an open chat, as REST results (not throws). */
async function _accessFor(userId, sessionId) {
  if (!mongoose.isValidObjectId(sessionId)) return { error: _fail(404, 'SESSION_NOT_FOUND', 'Session not found') };
  const session = await MovieSession.findById(sessionId);
  if (!session) return { error: _fail(404, 'SESSION_NOT_FOUND', 'Session not found') };
  if (!session.participants.some(p => p.toString() === userId.toString())) {
    return { error: _fail(403, 'NOT_A_MEMBER', 'You are not a member of this session') };
  }
  if (session.status === 'expired') return { error: _fail(409, 'CHAT_CLOSED', 'This chat is no longer available') };
  return { session };
}

async function _ownMessage(userId, sessionId, messageId) {
  if (!mongoose.isValidObjectId(messageId)) return { error: _fail(404, 'MESSAGE_NOT_FOUND', 'Message not found') };
  const m = await MovieMessage.findOne({ _id: messageId, sessionId }).lean();
  if (!m) return { error: _fail(404, 'MESSAGE_NOT_FOUND', 'Message not found') };
  if (m.type === 'system') return { error: _fail(422, 'CANNOT_CHANGE', 'Updates in the chat cannot be changed.') };
  if (!m.senderId || m.senderId.toString() !== userId.toString()) {
    return { error: _fail(403, 'NOT_MESSAGE_AUTHOR', 'You can only change your own messages.') };
  }
  if (m.deletedAt) return { error: _fail(410, 'MESSAGE_DELETED', 'This message was deleted.') };
  return { message: m };
}

/**
 * PATCH /movie-session/:id/messages/:messageId  { text }
 * The author only, a text message only, not deleted, within 15 minutes of sending
 * (server clock) — one conditional update decides it, so a late or post-delete edit
 * changes nothing. The message id never changes; the room gets 'movieMessageUpdated'.
 */
async function editMovieMessage(userId, sessionId, messageId, rawText, io, now = Date.now()) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return _fail(422, 'INVALID_MESSAGE', 'Message text required');
  if (text.length > TEXT_MAX) return _fail(422, 'INVALID_MESSAGE', 'Message is too long');
  const access = await _accessFor(userId, sessionId);
  if (access.error) return access.error;
  const own = await _ownMessage(userId, sessionId, messageId);
  if (own.error) return own.error;
  const m = own.message;
  if (m.type !== 'text') return _fail(422, 'CANNOT_EDIT', 'Voice notes cannot be edited.');
  const windowPassed = _fail(409, 'EDIT_WINDOW_PASSED', 'Messages can only be edited for 15 minutes after sending.');
  if (now - new Date(m.createdAt).getTime() > EDIT_WINDOW_MS) return windowPassed;

  if (m.text === text) {
    const targets = await loadReplyTargets([m]);
    return { success: true, status: 200, message: formatMovieMessage(m, targets) };   // nothing to change
  }
  const updated = await MovieMessage.findOneAndUpdate(
    { _id: m._id, sessionId, type: 'text', senderId: userId, deletedAt: null,
      createdAt: { $gte: new Date(now - EDIT_WINDOW_MS) } },
    { $set: { text, editedAt: new Date(now) } },
    { new: true },
  );
  if (!updated) {
    const again = await MovieMessage.findById(m._id).select('deletedAt').lean();
    return again && again.deletedAt ? _fail(410, 'MESSAGE_DELETED', 'This message was deleted.') : windowPassed;
  }
  await _broadcastUpdate(io, sessionId, updated);
  const targets = await loadReplyTargets([updated]);
  return { success: true, status: 200, message: formatMovieMessage(updated, targets) };
}

/**
 * DELETE /movie-session/:id/messages/:messageId — delete for everyone, by its author.
 * A soft delete (Sports' pattern): the row keeps its place, its text and voice URL are
 * never returned again. Once only; the room gets 'movieMessageUpdated' { deleted: true }.
 */
async function deleteMovieMessage(userId, sessionId, messageId, io, now = Date.now()) {
  const access = await _accessFor(userId, sessionId);
  if (access.error) return access.error;
  const own = await _ownMessage(userId, sessionId, messageId);
  if (own.error) return own.error;
  const updated = await MovieMessage.findOneAndUpdate(
    { _id: own.message._id, sessionId, senderId: userId, deletedAt: null },
    { $set: { deletedAt: new Date(now), deletedBy: userId } },
    { new: true },
  );
  if (!updated) return _fail(410, 'MESSAGE_DELETED', 'This message was deleted.');
  if (access.session.pinnedMessageId && access.session.pinnedMessageId.toString() === updated._id.toString()) {
    await MovieSession.updateOne({ _id: sessionId, pinnedMessageId: updated._id }, { $set: { pinnedMessageId: null } });
    if (io) io.to(`movie:${sessionId}`).emit('messagePinned', { pinnedMessageId: null });
  }
  await _broadcastUpdate(io, sessionId, updated);
  return { success: true, status: 200, message: formatMovieMessage(updated) };
}

/**
 * A server-written system row in the chat the screen reads (MovieMessage), e.g.
 * "Asha joined the hangout". Additive: the legacy MovieChat copy is still written.
 */
async function postSystemMessage(sessionId, text, io) {
  const msg = await MovieMessage.create({ sessionId, senderId: null, senderName: 'Humrah', type: 'system', text });
  await _broadcastMessage(io, sessionId, msg);
  return msg;
}

function _sendFCM(sessionId, msg, senderName, isVoice) {
  // This will be called asynchronously without awaiting.
  // We defer to notificationService to avoid circular dependencies and handle the logic
  const notificationService = require('./notificationService');
  if (notificationService && notificationService.sendMovieHangoutNotification) {
    notificationService.sendMovieHangoutNotification(sessionId, msg, senderName, isVoice).catch(err => {
      console.error('FCM Error:', err);
    });
  }
}

module.exports = {
  handleSocketMessage,
  handleSocketVoiceNote,
  handleMessageReaction,
  handlePinMessage,
  handlePollVote,
  handleMarkRead,
  editMovieMessage,
  deleteMovieMessage,
  postSystemMessage,
  formatMovieMessage,
  loadReplyTargets,
  EDIT_WINDOW_MS,
};
