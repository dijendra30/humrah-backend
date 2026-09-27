// models/SportsAttendancePoll.js
// -----------------------------------------------------------------------------
// Sports chat enhancement — the attendance check. One per Sports session, opened
// by the server an hour before the game ("Are you still coming?") and closed at
// the game's start, when its result is posted to the chat.
//
//   SportsPlan ──1:1── SportsSession ──1:0..1── SportsAttendancePoll
//
// Humrah has no poll feature to reuse; this is the smallest Sports-only shape.
//
// sessionId is unique: it IS the idempotency key ("ATTENDANCE_POLL:<sessionId>"),
// so however many times the scheduler runs, on however many servers, a session
// gets one poll. Every later step is a conditional update on this document (the
// close, the result message, each notification claim), so a step can be retried
// but never done twice.
//
// responses: one entry per person who answered (at most the plan's player limit,
// ≤ 12). Only ids, the answer and when. What COUNTS is decided when read or
// closed: answers from people who are still in the plan. Someone who leaves or is
// removed after voting no longer counts. Identities are never shown to anyone.
//
// Not chat activity: nothing here ever moves SportsSession.lastMessageAt.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const ANSWERS  = ['YES', 'NO'];
const OUTCOMES = ['YES_MAJORITY', 'NO_MAJORITY', 'SPLIT', 'NO_RESPONSES', 'CANCELLED'];

const responseSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answer:      { type: String, enum: ANSWERS, required: true },
  respondedAt: { type: Date, required: true },
}, { _id: false });

const sportsAttendancePollSchema = new mongoose.Schema({
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SportsSession', required: true },
  sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  status:       { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
  openedAt:     { type: Date, required: true },
  // = the plan's startTime when opened (plans cannot be edited).
  closesAt:     { type: Date, required: true },
  closedAt:     { type: Date, default: null },
  // Who was in the plan when it opened — who the opening notification went to.
  eligibleAtOpen: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  responses:    { type: [responseSchema], default: [] },
  // Frozen at close, from current members only.
  result: {
    type: new mongoose.Schema({
      yes:      { type: Number, default: 0 },
      no:       { type: Number, default: 0 },
      eligible: { type: Number, default: 0 },
      outcome:  { type: String, enum: OUTCOMES, required: true },
      // Closed so late (after the game ended) that posting it would be noise.
      announced: { type: Boolean, default: true },
    }, { _id: false }),
    default: null,
  },
  pollMessageId:   { type: mongoose.Schema.Types.ObjectId, ref: 'SportsMessage', default: null },
  resultMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsMessage', default: null },
  // Claimed before sending (a duplicate nudge is worse than a missed one).
  notifications: {
    openClaimedAt:   { type: Date, default: null },
    openSent:        { type: Number, default: 0 },
    resultClaimedAt: { type: Date, default: null },
    resultSent:      { type: Number, default: 0 },
  },
}, { timestamps: true });

// One poll per session — the idempotency key.
sportsAttendancePollSchema.index({ sessionId: 1 }, { unique: true });
// The scheduler: open polls that are due to close.
sportsAttendancePollSchema.index({ status: 1, closesAt: 1 });
// The scheduler: which candidate plans already have a poll.
sportsAttendancePollSchema.index({ sportsPlanId: 1 });

module.exports = mongoose.model('SportsAttendancePoll', sportsAttendancePollSchema);
module.exports.ANSWERS = ANSWERS;
module.exports.OUTCOMES = OUTCOMES;
