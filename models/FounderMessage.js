const mongoose = require('mongoose');

const founderMessageSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userSnapshot: {
    name: { type: String, required: true },
    email: { type: String, required: true }
  },
  category: {
    type: String,
    required: true,
    enum: [
      // Canonical
      'BUG_REPORT', 'FEATURE_IDEA', 'FEEDBACK', 'SAFETY_CONCERN', 'APPRECIATION', 'PARTNERSHIP', 'OTHER',
      // Legacy compatibility
      'BUG', 'FEATURE_REQUEST', 'COMPLAINT'
    ]
  },
  replyPreference: {
    type: String,
    required: true,
    enum: ['NO_REPLY', 'EMAIL', 'FOLLOW_UP']
  },
  emailStatus: {
    type: String,
    enum: ['NONE', 'PENDING', 'SENDING', 'SENT', 'FAILED'],
    default: 'NONE'
  },
  subject: {
    type: String,
    trim: true,
    maxlength: 150
  },
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 5000
  },
  attachments: [{
    url: { type: String, required: true },
    publicId: { type: String, required: true }
  }],
  status: {
    type: String,
    enum: ['UNREAD', 'READING', 'REPLIED', 'DISCUSSION_STARTED', 'CLOSED'],
    default: 'UNREAD'
  },
  priority: {
    type: String,
    enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
    default: 'NORMAL'
  },
  founderReply: {
    type: String,
    default: null
  },
  internalNotes: {
    type: String,
    default: null
  },
  readTimestamp: {
    type: Date,
    default: null
  },
  replyTimestamp: {
    type: Date,
    default: null
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  isStarred: {
    type: Boolean,
    default: false
  },
  deviceInfo: {
    type: String,
    default: null
  },
  appVersion: {
    type: String,
    default: null
  }
}, { timestamps: true });

// Indexes for performance
founderMessageSchema.index({ status: 1 });
founderMessageSchema.index({ category: 1 });
founderMessageSchema.index({ user: 1 });
founderMessageSchema.index({ createdAt: -1 });
founderMessageSchema.index({ isArchived: 1 });
founderMessageSchema.index({ isDeleted: 1 });

module.exports = mongoose.model('FounderMessage', founderMessageSchema);
