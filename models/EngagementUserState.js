// models/EngagementUserState.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications (Phase 1): the per-ACCOUNT frequency ledger.
//
// One document per user (unique userId). It is the only authority for the rolling
// 72-hour limit and is changed only by services/engagement/frequency.js through
// conditional single-document updates, which MongoDB applies atomically:
//
//   reserve  : only if activeNotificationId is null AND (lastSentAt is null OR
//              lastSentAt <= now - window). Sets activeNotificationId.
//   consume  : the reserved notification was sent (or may have been): lastSentAt = send time.
//   release  : the reserved notification definitely did not reach FCM: clear it, lastSentAt unchanged.
//
// Per account, not per device: a user with three phones has one row. Logging in
// again never touches this collection. Broadcasts never touch it.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const engagementUserStateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Time FCM accepted the last engagement notification (or the attempt time of one
  // whose outcome is unknown). The 72-hour window runs from here.
  lastSentAt: { type: Date, default: null },
  lastNotificationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  lastCategory: { type: String, default: null },

  // The reservation: the one notification that currently owns this user's slot.
  activeNotificationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  activeSince: { type: Date, default: null },

  sentCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

engagementUserStateSchema.index({ userId: 1 }, { unique: true });
// Orphan-reservation sweep (a worker died between reserving and enqueueing). Partial,
// so only rows that currently hold a reservation are in it.
engagementUserStateSchema.index(
  { activeSince: 1 },
  { partialFilterExpression: { activeNotificationId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('EngagementUserState', engagementUserStateSchema);
