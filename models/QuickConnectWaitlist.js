// models/QuickConnectWaitlist.js
// -----------------------------------------------------------------------------
// Quick Connect "Notify me": people who asked to hear when Quick Connect may have room.
// _id IS the user id, so a user has at most one entry (atomic). Order = createdAt (FIFO).
//   WAITING   in the queue
//   NOTIFIED  told "may be available" (no slot is reserved); removed after a short claim
//             window so the next people in line can be told.
// fcmToken is one of the user's OWN registered device tokens (checked on join), so only the
// device that asked is notified. Expires automatically (TTL on expiresAt). Nothing else.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const waitlistSchema = new mongoose.Schema({
  _id:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  state:      { type: String, enum: ['WAITING', 'NOTIFIED'], required: true, default: 'WAITING' },
  createdAt:  { type: Date, required: true },
  expiresAt:  { type: Date, required: true },
  fcmToken:   { type: String, default: null },
  notifiedAt: { type: Date, default: null }
}, { versionKey: false, collection: 'quickconnectwaitlist' });

waitlistSchema.index({ state: 1, createdAt: 1 });
waitlistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.QuickConnectWaitlist || mongoose.model('QuickConnectWaitlist', waitlistSchema);
