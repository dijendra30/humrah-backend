// models/SportsSession.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 2A. The session a Sports plan becomes: the group of
// people playing, which Messages → Sessions lists and Phase 3's group chat will
// hang off.
//
// Exactly one per plan (unique sportsPlanId). The plan stays the source of truth
// for WHO is in it (SportsPlan.playersJoined) and WHEN (startTime / endTime);
// this document carries only what belongs to the session itself. Its members are
// SportsSessionMember documents, kept in step with the plan — see
// services/sportsSessionService.js.
//
//   status  'active' until the plan is cancelled, then 'cancelled'. Upcoming /
//           live / ended are worked out from the plan's times when read, the way
//           Phase 1A derives an expired card, so nothing has to flip them on time.
//
// No TTL and never deleted: a session is the plan's history, and Phase 3 will
// keep its messages.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const sportsSessionSchema = new mongoose.Schema({
  sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  creatorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:       { type: String, enum: ['active', 'cancelled'], default: 'active' },
  cancelledAt:  { type: Date, default: null },
  // Phase 3 (group chat) sets this from a persisted message. Null until then.
  lastMessageAt: { type: Date, default: null },
}, { timestamps: true });

// One session per plan. Also what makes creation idempotent: a retried or racing
// create upserts onto the same document instead of adding a second.
sportsSessionSchema.index({ sportsPlanId: 1 }, { unique: true });

module.exports = mongoose.model('SportsSession', sportsSessionSchema);
