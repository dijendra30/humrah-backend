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
  }
});

const Notification = mongoose.model('Notification', notificationSchema);
module.exports = Notification;
