// models/PrivateSafetyConcern.js
// -----------------------------------------------------------------------------
// A safety concern the user saved with "Keep Private" ON. It belongs to that user
// alone: it is NOT a SafetyTicket, so no Safety Team list, admin dashboard, analytics
// query, Telegram alert, push or socket ever sees it — they all read SafetyTicket.
//
//   PRIVATE          saved; only its owner can read it (every query is by userId)
//   SENT_FOR_REVIEW  the owner chose "Send to Safety Team": a SafetyTicket was created
//                    through the existing ticket flow (ticketId), once
//
// Kept when the owner leaves or deletes the session from their list: it is their
// safety record, not part of the chat. Context is ids only.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const CONCERN_TYPES = ['felt_uncomfortable', 'inappropriate_message', 'felt_pressured_or_unsafe', 'something_else'];
const STATES = ['PRIVATE', 'SENT_FOR_REVIEW'];

const privateSafetyConcernSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Where it was saved. Sports sessions only, for now.
  context: {
    kind:         { type: String, enum: ['SPORTS_SESSION'], required: true },
    sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SportsSession', required: true },
    sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  },
  concernType: { type: String, enum: CONCERN_TYPES, required: true },
  note:        { type: String, default: '', trim: true, maxlength: 500 },
  state:       { type: String, enum: STATES, default: 'PRIVATE', required: true },
  sentForReviewAt: { type: Date, default: null },
  ticketId:        { type: String, default: null },   // the SafetyTicket's HST-… id once sent
}, { timestamps: true });

// The owner's concerns for one session, newest first (the chat header icon).
privateSafetyConcernSchema.index({ userId: 1, 'context.sessionId': 1, createdAt: -1 });

module.exports = mongoose.model('PrivateSafetyConcern', privateSafetyConcernSchema);
module.exports.CONCERN_TYPES = CONCERN_TYPES;
module.exports.STATES = STATES;
