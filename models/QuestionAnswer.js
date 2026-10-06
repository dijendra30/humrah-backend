// models/QuestionAnswer.js
// -----------------------------------------------------------------------------
// An answer to a Question. One ACTIVE answer per person per question (a deleted one
// does not count). Soft delete only. It is not a chat: nothing here opens one.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:       { type: String, required: true, maxlength: 4000 },   // 300 graphemes
  status:     { type: String, enum: ['ACTIVE', 'DELETED', 'HIDDEN'], default: 'ACTIVE', required: true },
  replyCount: { type: Number, default: 0, min: 0 },
  deletedAt:  { type: Date, default: null },
  // ── Admin (never sent to the app) ──
  moderationState: { type: String, enum: ['ALLOWED', 'FLAGGED', 'UNDER_REVIEW', 'REVIEWED'], default: 'ALLOWED' },
  reportCount:     { type: Number, default: 0, min: 0 },
  hiddenAt:        { type: Date, default: null },
  hiddenBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  restoredFromRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // ── Phase 4 pushes (never sent to the app) ──
  // The asker's push for this answer: null (not yet considered) → QUEUED (taken; waiting
  // to be sent now or by the tick) → SENT or SKIPPED. Every step is a conditional update,
  // so a retried or concurrent call can never announce the same answer twice.
  ownerPush:       { type: String, enum: [null, 'QUEUED', 'SENT', 'SKIPPED'], default: null },
  ownerNotifiedAt: { type: Date, default: null },
  // The last reply push in this thread, per side: at most one per window each way.
  replyPush: {
    toAskerAt:  { type: Date, default: null },
    toAuthorAt: { type: Date, default: null },
  },
}, { timestamps: true });

// One active answer per person per question.
answerSchema.index({ questionId: 1, authorId: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });
// The answers of a question, oldest first.
answerSchema.index({ questionId: 1, createdAt: 1 });
// Admin: answers over time, a person's answers.
answerSchema.index({ createdAt: -1 });
answerSchema.index({ authorId: 1, createdAt: -1 });

module.exports = mongoose.model('QuestionAnswer', answerSchema);
