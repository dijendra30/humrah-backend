// models/RandomBookingChat.js - FIXED SYSTEM MESSAGE
const mongoose = require('mongoose');
const crypto = require('crypto');

const randomBookingChatSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBooking',
    required: true,
    unique: true,
    index: true
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
    index: true
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
    index: true
  },
  
  hasReport: {
    type: Boolean,
    default: false,
    index: true
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
    index: true
  },
  
  deletedAt: {
    type: Date,
    default: null
  },
  
  lastMessageAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES
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

randomBookingChatSchema.methods.deleteChat = async function() {
  if (!this.canDelete()) {
    throw new Error('Cannot delete chat: either not expired or under review');
  }
  
  this.isDeleted = true;
  this.deletedAt = new Date();
  await this.save();
  
  const Message = mongoose.model('Message');
  await Message.deleteMany({ chatId: this._id });
  
  const EncryptionKey = mongoose.model('EncryptionKey');
  await EncryptionKey.deleteOne({ keyId: this.encryptionKeyId });
  
  return true;
};

// =============================================
// STATIC METHODS
// =============================================

/**
 * ✅ FIXED: Create chat with proper system message
 */
randomBookingChatSchema.statics.createForBooking = async function(booking) {
  const existing = await this.findOne({ bookingId: booking._id });
  if (existing) return existing;
  
  // Create encryption key
  const EncryptionKey = mongoose.model('EncryptionKey');
  const keyId = crypto.randomBytes(32).toString('hex');
  const encryptionKey = crypto.randomBytes(32).toString('base64');
  
  await EncryptionKey.create({
    keyId,
    key: encryptionKey,
    createdFor: 'RANDOM_BOOKING',
    expiresAt: new Date(booking.date.getTime() + 24 * 60 * 60 * 1000)
  });
  
  // Create chat
  const chat = await this.create({
    bookingId: booking._id,
    participants: [
      { userId: booking.initiatorId, role: 'INITIATOR' },
      { userId: booking.acceptedUserId, role: 'ACCEPTER' }
    ],
    encryptionKeyId: keyId,
    expiresAt: new Date(booking.date.getTime() + 24 * 60 * 60 * 1000)
  });
  
  // ✅ FIXED: Create system message with initiator as sender
  // System messages should come from one of the participants
  const Message = mongoose.model('Message');
  await Message.create({
    chatId: chat._id,
    senderId: booking.initiatorId,  // ✅ Use initiator, not null
    senderRole: 'USER',              // ✅ Use USER, not SYSTEM
    content: '🎉 You\'re matched!\nYou can now chat and plan your meetup.\nThis conversation will disappear after today.',
    messageType: 'TEXT',
    isSystemMessage: true            // ✅ Add this flag if your Message model supports it
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

randomBookingChatSchema.statics.cleanupExpired = async function() {
  const now = new Date();
  
  const expiredChats = await this.find({
    status: { $in: ['COMPLETED', 'ACTIVE'] },
    expiresAt: { $lt: now },
    hasReport: false,
    isDeleted: false
  });
  
  let deleted = 0;
  
  for (const chat of expiredChats) {
    try {
      await chat.deleteChat();
      deleted++;
    } catch (error) {
      console.error(`Failed to delete chat ${chat._id}:`, error.message);
    }
  }
  
  return { deleted, total: expiredChats.length };
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
