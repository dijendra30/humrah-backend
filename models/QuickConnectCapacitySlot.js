// models/QuickConnectCapacitySlot.js
// -----------------------------------------------------------------------------
// Quick Connect capacity: one document per open session (PROPOSED → CONNECTED), numbered
// 0 … QUICK_CONNECT_MAX_ACTIVE_CALLS-1. The slot number is the _id, so two requests can
// never take the same slot (MongoDB _id uniqueness) and the number of slots below the
// limit can never exceed it — no transaction needed, safe with several backend processes.
// Claimed in sessions.createSession, released on every end (services/quickConnect/
// capacity.js), and reconciled by the sweeper after crashes. No user data.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const slotSchema = new mongoose.Schema({
  _id:       { type: Number },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuickConnectSession', required: true },
  claimedAt: { type: Date, required: true }
}, { versionKey: false, collection: 'quickconnectcapacityslots' });

slotSchema.index({ sessionId: 1 });

module.exports = mongoose.models.QuickConnectCapacitySlot || mongoose.model('QuickConnectCapacitySlot', slotSchema);
