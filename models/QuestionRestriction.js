// models/QuestionRestriction.js
// -----------------------------------------------------------------------------
// A QUESTION-CREATION-ONLY restriction. It is not an account suspension: while it runs
// the person cannot post a new question, and nothing else changes — they can still view
// and answer questions, reply, chat, use Rooms, Sports, Community and everything else.
// The account's status, suspensionInfo and moderation strikes are never touched.
//
// Ladder (services/questionService.js, applyQuestionRestriction):
//   level 1 → 1 hour · 2 → 1 day · 3 → 2 days · 4 → 4 days · 5 → final (no end date;
//   only an admin lifts it).
// history keeps every step, including admin lifts and resets (who, when, why).
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  action:   { type: String, enum: ['APPLIED', 'LIFTED', 'RESET'], required: true },
  level:    { type: Number, required: true },
  reason:   { type: String, default: null, maxlength: 100 },
  until:    { type: Date, default: null },
  final:    { type: Boolean, default: false },
  by:       { type: String, default: 'SYSTEM' },                 // 'SYSTEM' or the admin's user id
  note:     { type: String, default: null, maxlength: 300 },
  at:       { type: Date, default: Date.now },
}, { _id: false });

const restrictionSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  level:           { type: Number, default: 0, min: 0 },
  restrictedUntil: { type: Date, default: null },
  final:           { type: Boolean, default: false },              // level 5: until an admin lifts it
  restrictionReason: { type: String, default: null, maxlength: 100 },
  lastAppliedAt:   { type: Date, default: null },
  history:         { type: [stepSchema], default: [] },
}, { timestamps: true });

restrictionSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.model('QuestionRestriction', restrictionSchema);
