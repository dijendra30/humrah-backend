// models/LetterNotification.js
// Aggregated in-app notifications for Humrah Letters activity inbox.
// One document per (recipient, letter, type) — counts are incremented via $inc upsert
// so multiple reactions collapse into a single card rather than spamming the inbox.

const mongoose = require('mongoose');

const letterNotificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    letterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Letter',
      required: true
    },
    type: {
      type: String,
      enum: ['comfort', 'warmth', 'note'],
      required: true
    },
    // Only populated for type === 'note' (first 100 chars of the reply body)
    preview: {
      type: String,
      default: null,
      maxlength: 150
    },
    // Aggregated reaction count (incremented each time someone reacts)
    count: {
      type: Number,
      default: 1,
      min: 1
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  { timestamps: true }
);

// Compound unique index: one notification card per (recipient, letter, type).
// Subsequent actions increment `count` and reset `isRead = false`.
letterNotificationSchema.index(
  { recipientId: 1, letterId: 1, type: 1 },
  { unique: true }
);

// Index for fast inbox query (newest unread first)
letterNotificationSchema.index({ recipientId: 1, createdAt: -1 });

module.exports = mongoose.model('LetterNotification', letterNotificationSchema);
