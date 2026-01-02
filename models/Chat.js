// models/Chat.js - Chat System with BOOKING and SUPPORT types
const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  // Chat Type
  chatType: {
    type: String,
    enum: ['BOOKING', 'SUPPORT'],
    required: true,
    index: true
  },
  
  // Participants
  participants: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    role: {
      type: String,
      enum: ['USER', 'SAFETY_ADMIN', 'SUPER_ADMIN'],
      required: true
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    leftAt: Date,
    isActive: {
      type: Boolean,
      default: true
    }
  }],
  
  // For SUPPORT chats - link to safety report
  linkedReportId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SafetyReport',
    default: null,
    index: true
  },
  
  // For BOOKING chats - link to booking
  linkedBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    default: null
  },
  
  // Chat Status
  status: {
    type: String,
    enum: ['ACTIVE', 'CLOSED', 'ARCHIVED'],
    default: 'ACTIVE',
    index: true
  },
  
  // Closure Information
  closedAt: Date,
  closedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  closureReason: String,
  
  // Metadata
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  
  // Unread counts per user
  unreadCounts: {
    type: Map,
    of: Number,
    default: new Map()
  },
  
  // Labels for categorization
  labels: [{
    type: String,
    enum: ['urgent', 'follow_up', 'resolved', 'escalated']
  }],
  
  // Admin-only notes (not visible to users)
  adminNotes: [{
    note: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES
// =============================================
chatSchema.index({ chatType: 1, status: 1 });
chatSchema.index({ 'participants.userId': 1 });
chatSchema.index({ linkedReportId: 1 });
chatSchema.index({ lastMessageAt: -1 });

// =============================================
// VALIDATION
// =============================================
// Validate SUPPORT chat must have linkedReportId
chatSchema.pre('save', function (next) {
  if (this.chatType === 'SUPPORT' && !this.linkedReportId) {
    return next(new Error('SUPPORT chats must have a linkedReportId'));
  }
  next();
});

// Validate participants
chatSchema.pre('save', function (next) {
  if (this.participants.length < 2) {
    return next(new Error('Chat must have at least 2 participants'));
  }
  
  // For SUPPORT chats, ensure at least one admin
  if (this.chatType === 'SUPPORT') {
    const hasAdmin = this.participants.some(p => 
      p.role === 'SAFETY_ADMIN' || p.role === 'SUPER_ADMIN'
    );
    
    if (!hasAdmin) {
      return next(new Error('SUPPORT chats must have at least one admin'));
    }
  }
  
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================
// Check if user is participant
chatSchema.methods.isParticipant = function (userId) {
  return this.participants.some(p => 
    p.userId.toString() === userId.toString() && p.isActive
  );
};

// Check if user is admin in this chat
chatSchema.methods.isAdminParticipant = function (userId) {
  const participant = this.participants.find(p => 
    p.userId.toString() === userId.toString()
  );
  
  return participant && (
    participant.role === 'SAFETY_ADMIN' || 
    participant.role === 'SUPER_ADMIN'
  );
};

// Get unread count for user
chatSchema.methods.getUnreadCount = function (userId) {
  return this.unreadCounts.get(userId.toString()) || 0;
};

// Increment unread count for user
chatSchema.methods.incrementUnread = function (userId) {
  const key = userId.toString();
  const current = this.unreadCounts.get(key) || 0;
  this.unreadCounts.set(key, current + 1);
  return this.save();
};

// Reset unread count for user
chatSchema.methods.resetUnread = function (userId) {
  this.unreadCounts.set(userId.toString(), 0);
  return this.save();
};

// Close chat
chatSchema.methods.closeChat = function (userId, reason) {
  this.status = 'CLOSED';
  this.closedAt = new Date();
  this.closedBy = userId;
  this.closureReason = reason;
  return this.save();
};

// Reopen chat
chatSchema.methods.reopenChat = function () {
  this.status = 'ACTIVE';
  this.closedAt = null;
  this.closedBy = null;
  this.closureReason = null;
  return this.save();
};

// Add participant
chatSchema.methods.addParticipant = function (userId, role) {
  // Check if already participant
  const existing = this.participants.find(p => 
    p.userId.toString() === userId.toString()
  );
  
  if (existing) {
    existing.isActive = true;
    existing.leftAt = null;
  } else {
    this.participants.push({
      userId,
      role,
      joinedAt: new Date(),
      isActive: true
    });
  }
  
  return this.save();
};

// Remove participant
chatSchema.methods.removeParticipant = function (userId) {
  const participant = this.participants.find(p => 
    p.userId.toString() === userId.toString()
  );
  
  if (participant) {
    participant.isActive = false;
    participant.leftAt = new Date();
  }
  
  return this.save();
};

// Check if chat is read-only
chatSchema.methods.isReadOnly = function () {
  return this.status === 'CLOSED' || this.status === 'ARCHIVED';
};

// =============================================
// STATIC METHODS
// =============================================
// Find active chats for user
chatSchema.statics.findActiveForUser = function (userId) {
  return this.find({
    'participants.userId': userId,
    'participants.isActive': true,
    status: 'ACTIVE'
  }).sort({ lastMessageAt: -1 });
};

// Find support chats for admin
chatSchema.statics.findSupportChatsForAdmin = function () {
  return this.find({
    chatType: 'SUPPORT',
    status: { $in: ['ACTIVE', 'CLOSED'] }
  }).sort({ lastMessageAt: -1 });
};

// Find chat by report
chatSchema.statics.findByReport = function (reportId) {
  return this.findOne({
    linkedReportId: reportId
  });
};

module.exports = mongoose.model('Chat', chatSchema);
