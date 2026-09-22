// models/RandomBookingChat.js - FIXED SYSTEM MESSAGE
const mongoose = require('mongoose');
const crypto = require('crypto');

const randomBookingChatSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBooking',
    required: true,
    unique: true,
    // ✅ FIX: removed index:true — unique:true already creates the index
  },

  participants: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    role: {
      type: String,
      enum: ['INITIATOR', 'ACCEPTER'],
      required: true
    }
  }],

  encryptionKeyId: {
    type: String,
    required: true,
    unique: true
  },

  status: {
    type: String,
    enum: ['ACTIVE', 'COMPLETED', 'EXPIRED', 'UNDER_REVIEW'],
    default: 'ACTIVE',
    required: true,
    // ✅ FIX: removed index:true — covered by compound index({ status, expiresAt }) below
  },

  createdAt: {
    type: Date,
    default: Date.now,
    required: true
  },

  completedAt: {
    type: Date,
    default: null
  },

  expiresAt: {
    type: Date,
    required: true,
    // ✅ FIX: removed index:true — this was the duplicate causing the warning.
    // The compound index({ status: 1, expiresAt: 1 }) below already indexes expiresAt.
  },

  hasReport: {
    type: Boolean,
    default: false,
    // ✅ FIX: removed index:true — covered by compound index({ hasReport, status }) below
  },

  reportId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SafetyReport',
    default: null
  },

  reportedAt: {
    type: Date,
    default: null
  },

  isDeleted: {
    type: Boolean,
    default: false,
    index: true   // standalone — not in any compound, keep it
  },

  deletedAt: {
    type: Date,
    default: null
  },

  lastMessageAt: {
    type: Date,
    default: Date.now
  },

  // ── Two-stage message retention ─────────────────────────────────────────────
  // `expiresAt` above is when the chat stops being usable and disappears from the
  // Messages screen. It is NOT when the words are deleted any more.
  //
  // Text is purged later, at `messagesPurgeAt`, so a report raised shortly after a
  // chat closes still has something to look at. Fixed at booking.startTime + 48h so
  // it does not move when a rating shortens `expiresAt`.
  //
  // Null on every chat created before this field existed; cleanupExpired falls back
  // to expiresAt + 24h for those, which is the same instant, because their expiresAt
  // was always startTime + 24h.
  messagesPurgeAt: {
    type: Date,
    default: null
  },

  messagesPurgedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES — single source of truth
// =============================================
randomBookingChatSchema.index({ 'participants.userId': 1 });
randomBookingChatSchema.index({ status: 1, expiresAt: 1 });
randomBookingChatSchema.index({ hasReport: 1, status: 1 });

// =============================================
// PRE-SAVE VALIDATION
// =============================================
randomBookingChatSchema.pre('save', function(next) {
  if (this.participants.length !== 2) {
    return next(new Error('Chat must have exactly 2 participants'));
  }
  if (this.isNew && !this.encryptionKeyId) {
    this.encryptionKeyId = crypto.randomBytes(32).toString('hex');
  }
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================
randomBookingChatSchema.methods.isParticipant = function(userId) {
  return this.participants.some(p =>
    p.userId.toString() === userId.toString()
  );
};

randomBookingChatSchema.methods.markCompleted = function() {
  this.status = 'COMPLETED';
  this.completedAt = new Date();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  this.expiresAt = endOfDay;
  return this.save();
};

randomBookingChatSchema.methods.flagForReview = function(reportId) {
  this.status = 'UNDER_REVIEW';
  this.hasReport = true;
  this.reportId = reportId;
  this.reportedAt = new Date();
  this.expiresAt = new Date('2099-12-31');
  return this.save();
};

randomBookingChatSchema.methods.isExpired = function() {
  return this.expiresAt < new Date();
};

randomBookingChatSchema.methods.canDelete = function() {
  return this.isExpired() && !this.hasReport && this.status !== 'UNDER_REVIEW';
};

/**
 * Stage 1 — close the chat.
 *
 * Hides it from the Messages screen and stops it being usable. Messages are
 * deliberately left in place; they are removed later by [purgeMessageText].
 *
 * Split out of deleteChat() because closing and forgetting used to be the same
 * instant, which left nothing to review if a report arrived just after a chat ended.
 */
randomBookingChatSchema.methods.expireChat = async function() {
  if (this.isDeleted) return false;
  // UNDER_REVIEW is a moderation state, not a lifecycle state. Overwriting it with
  // EXPIRED would lose the fact that the chat is being looked at — flagForReview()
  // deliberately pushes expiresAt out to 2099 to keep it alive, and this must not
  // quietly undo that if the two ever race.
  if (this.status !== 'UNDER_REVIEW') this.status = 'EXPIRED';
  this.isDeleted = true;
  this.deletedAt = new Date();
  await this.save();
  return true;
};

/**
 * Stage 2 — remove the words.
 *
 * Deletes user-authored TEXT messages only. Deliberately kept:
 *   • system messages (isSystemMessage) — the "You're matched" line
 *   • CALL_LOG entries and their callLogData
 *   • the chat record, its participants, the booking, and any rating
 *
 * That is the "text, not the data" split: what two people said to each other goes,
 * the record that they met does not.
 */
randomBookingChatSchema.methods.purgeMessageText = async function() {
  const Message = mongoose.model('Message');
  const result = await Message.deleteMany({
    chatId:          this._id,
    messageType:     'TEXT',
    isSystemMessage: false,
  });

  const EncryptionKey = mongoose.model('EncryptionKey');
  await EncryptionKey.deleteOne({ keyId: this.encryptionKeyId });

  this.messagesPurgedAt = new Date();
  await this.save();
  return result.deletedCount || 0;
};

/**
 * Kept for compatibility. Nothing calls it any more — cleanupExpired now runs the two
 * stages above — but it is a documented instance method, so it stays and does what it
 * always did, minus the part that is now stage 2's job.
 */
randomBookingChatSchema.methods.deleteChat = async function() {
  if (!this.canDelete()) {
    throw new Error('Cannot delete chat: either not expired or under review');
  }
  await this.expireChat();
  await this.purgeMessageText();
  return true;
};

// =============================================
// STATIC METHODS
// =============================================
randomBookingChatSchema.statics.createForBooking = async function(booking) {
  const existing = await this.findOne({ bookingId: booking._id });
  if (existing) return existing;

  const EncryptionKey = mongoose.model('EncryptionKey');
  const keyId = crypto.randomBytes(32).toString('hex');
  const encryptionKey = crypto.randomBytes(32).toString('base64');

  const chatExpiresAt = new Date(booking.startTime.getTime() + 24 * 60 * 60 * 1000);

  await EncryptionKey.create({
    keyId,
    key: encryptionKey,
    createdFor: 'RANDOM_BOOKING',
    expiresAt: chatExpiresAt
  });

  const chat = await this.create({
    bookingId: booking._id,
    participants: [
      { userId: booking.initiatorId, role: 'INITIATOR' },
      { userId: booking.acceptorId,  role: 'ACCEPTER' }
    ],
    encryptionKeyId: keyId,
    expiresAt: chatExpiresAt,
    // Anchored to the meetup, not to expiresAt, so that a rating shortening the chat
    // to two hours does not also pull the purge forward. Always 24h after the latest
    // possible close.
    messagesPurgeAt: new Date(booking.startTime.getTime() + 48 * 60 * 60 * 1000),
  });

  const Message = mongoose.model('Message');
  await Message.create({
    chatId: chat._id,
    senderId: booking.initiatorId,
    senderRole: 'USER',
    content: '🎉 You\'re matched!\nYou can now chat and plan your meetup.\nThis conversation will disappear after today.',
    messageType: 'TEXT',
    isSystemMessage: true
  });

  return chat;
};

randomBookingChatSchema.statics.findForUser = function(userId) {
  return this.find({
    'participants.userId': userId,
    isDeleted: false
  })
  .populate('bookingId')
  .sort({ lastMessageAt: -1 });
};

/**
 * Two-stage sweep, run hourly by cronJobs.js.
 *
 *   Stage 1  expiresAt      → close the chat, keep the messages
 *   Stage 2  messagesPurgeAt → delete the text
 *
 * Both stages are idempotent: stage 1 skips anything already closed, stage 2 skips
 * anything already purged. Removal from the Messages screen does not depend on this
 * running — GET /chats filters on expiresAt directly, so a chat disappears the moment
 * it expires rather than whenever the next sweep happens.
 */
randomBookingChatSchema.statics.cleanupExpired = async function() {
  const now = new Date();

  // ── Stage 1: close ────────────────────────────────────────────────────────
  // hasReport is no longer a reason to skip closing — a reported chat should still
  // stop being usable. It is stage 2 that leaves reported chats alone.
  const toExpire = await this.find({
    status:    { $in: ['COMPLETED', 'ACTIVE'] },
    expiresAt: { $lt: now },
    isDeleted: false,
  }).limit(500);

  let expired = 0;
  for (const chat of toExpire) {
    try {
      if (await chat.expireChat()) expired++;
    } catch (error) {
      console.error(`Failed to expire chat ${chat._id}:`, error.message);
    }
  }

  // ── Stage 2: purge text ───────────────────────────────────────────────────
  const legacyCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const toPurge = await this.find({
    isDeleted:        true,
    hasReport:        false,
    status:           { $ne: 'UNDER_REVIEW' },
    messagesPurgedAt: null,
    $or: [
      { messagesPurgeAt: { $lt: now } },
      // Chats created before messagesPurgeAt existed. Their expiresAt was always
      // startTime + 24h, so expiresAt + 24h is the same instant as startTime + 48h.
      { messagesPurgeAt: null, expiresAt: { $lt: legacyCutoff } },
    ],
  }).limit(500);

  let purged = 0;
  let messagesRemoved = 0;
  for (const chat of toPurge) {
    try {
      messagesRemoved += await chat.purgeMessageText();
      purged++;
    } catch (error) {
      console.error(`Failed to purge chat ${chat._id}:`, error.message);
    }
  }

  // `deleted` and `total` are kept so the existing cron log line still reads sensibly.
  return { expired, purged, messagesRemoved, deleted: expired, total: toExpire.length };
};

randomBookingChatSchema.statics.findUnderReview = function() {
  return this.find({
    status: 'UNDER_REVIEW',
    hasReport: true
  })
  .populate('bookingId')
  .populate('reportId')
  .populate('participants.userId', 'firstName lastName email')
  .sort({ reportedAt: -1 });
};

module.exports = mongoose.model('RandomBookingChat', randomBookingChatSchema);
