// models/Notification.js — Extended with broadcast delivery tracking (Phase 1)
// Backward-compatible: all existing fields preserved, new fields have defaults.

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['ADMIN_BROADCAST', 'SYSTEM', 'MATCH', 'ACTIVITY'],
    default: 'ADMIN_BROADCAST'
  },
  broadcastId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Broadcast',
    default: null
  },
  createdBy: {
    type: String,
    default: 'admin'
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  // =============================================
  // BROADCAST DELIVERY TRACKING (Phase 1)
  // =============================================
  deliveredAt: {
    type: Date,
    default: null
  },
  openedAt: {
    type: Date,
    default: null
  },
  fcmMessageId: {
    type: String,
    default: null
  },
  androidVersion: {
    type: String,
    default: null
  },
  appVersion: {
    type: String,
    default: null
  },
  failureReason: {
    type: String,
    default: null
  },
  clickedAt: {
    type: Date,
    default: null
  }
});

// Compound indexes for broadcast analytics
notificationSchema.index({ broadcastId: 1, userId: 1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ broadcastId: 1, deliveredAt: 1 });

const Notification = mongoose.model('Notification', notificationSchema);
module.exports = Notification;
