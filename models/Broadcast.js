// models/Broadcast.js — Broadcast Notification System (Phase 1)
// Stores broadcast metadata, audience targeting, and delivery analytics.

const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
  // =============================================
  // CONTENT
  // =============================================
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [120, 'Title cannot exceed 120 characters']
  },
  message: {
    type: String,
    required: [true, 'Message is required'],
    trim: true,
    maxlength: [1000, 'Message cannot exceed 1000 characters']
  },
  type: {
    type: String,
    enum: ['ANNOUNCEMENT', 'UPDATE', 'PROMOTION', 'ALERT', 'REMINDER'],
    default: 'ANNOUNCEMENT'
  },
  language: {
    type: String,
    enum: ['en', 'hi', 'both'],
    default: 'en'
  },

  // =============================================
  // AUDIENCE TARGETING
  // =============================================
  audienceType: {
    type: String,
    enum: ['EVERYONE', 'VERIFIED_USERS', 'PREMIUM_USERS', 'STATE', 'CITY', 'AREA', 'CUSTOM'],
    required: [true, 'Audience type is required']
  },
  targetState: {
    type: String,
    trim: true,
    default: null
  },
  targetCity: {
    type: String,
    trim: true,
    default: null
  },
  targetArea: {
    type: String,
    trim: true,
    default: null
  },
  // Combination filters — used with CUSTOM audienceType
  onlyVerifiedUsers: {
    type: Boolean,
    default: false
  },
  onlyPremiumUsers: {
    type: Boolean,
    default: false
  },

  // =============================================
  // LIFECYCLE
  // =============================================
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'],
    default: 'DRAFT',
    index: true
  },
  scheduledFor: {
    type: Date,
    default: null
  },
  sentAt: {
    type: Date,
    default: null
  },
  expiresAt: {
    type: Date,
    default: null
  },
  aiGenerated: {
    type: Boolean,
    default: false
  },

  // =============================================
  // DELIVERY ANALYTICS
  // Structured for future expansion (clicked, dismissed, etc.)
  // =============================================
  totalRecipients: {
    type: Number,
    default: 0,
    min: 0
  },
  deliveredCount: {
    type: Number,
    default: 0,
    min: 0
  },
  failedCount: {
    type: Number,
    default: 0,
    min: 0
  },
  openedCount: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // =============================================
  // RESUMABLE PROCESSING STATE
  // =============================================
  lastProcessedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  currentBatch: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true // adds createdAt + updatedAt automatically
});

// =============================================
// INDEXES
// =============================================
broadcastSchema.index({ status: 1, createdAt: -1 });
broadcastSchema.index({ createdBy: 1, createdAt: -1 });
broadcastSchema.index({ type: 1, status: 1 });

module.exports = mongoose.model('Broadcast', broadcastSchema);
