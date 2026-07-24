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
}

/**
 * Handle message reaction via Socket
 */
async function handleMessageReaction(userId, sessionId, messageId, reaction, io) {
  if (!['👍', '❤️', '😂', '😮', '😭'].includes(reaction)) throw new Error('Invalid reaction');
  await validateAccess(userId, sessionId);

  const message = await MovieMessage.findById(messageId);
  if (!message || message.sessionId.toString() !== sessionId.toString()) throw new Error('Message not found');

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

function _broadcastMessage(io, sessionId, msg) {
  if (!io) return;
  console.log(`Broadcasting message ${msg._id} to room: movie:${sessionId}`);
  io.to(`movie:${sessionId}`).emit('movieMessageReceived', {
    id:          msg._id.toString(),
    senderId:    msg.senderId?.toString() || null,
    senderName:  msg.senderName,
    senderPhoto: msg.senderPhoto || null,
    type:        msg.type,
    text:        msg.text,
    voiceUrl:    msg.voiceUrl || null,
    duration:    msg.duration || 0,
    replyTo:     msg.replyTo?.toString() || null,
    clientMessageId: msg.clientMessageId || null,
    readBy:      msg.readBy.map(r => r.toString()),
    reactions:   [],
    isSystem:    msg.type === 'system',
    timestamp:   msg.createdAt.toISOString(),
  });
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
  handleMarkRead
};
