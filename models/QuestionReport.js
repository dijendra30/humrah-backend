// models/QuestionReport.js
// -----------------------------------------------------------------------------
// A report of a question, answer or reply — the same per-content pattern as UserReport,
// PostReport and LetterReport. Reporting hides the content from the reporter only and
// queues it for Safety review. It NEVER restricts, suspends or bans anyone by itself.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const REASONS = ['OFFENSIVE', 'SPAM_OR_CONTACT', 'HARASSMENT', 'UNSAFE', 'MISLEADING', 'OTHER'];

const reportSchema = new mongoose.Schema({
  reporterId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetType:     { type: String, enum: ['QUESTION', 'ANSWER', 'REPLY'], required: true },
  targetId:       { type: mongoose.Schema.Types.ObjectId, required: true },
  questionId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason:         { type: String, enum: REASONS, required: true },
  description:    { type: String, default: '', maxlength: 500 },
  status:         { type: String, enum: ['OPEN', 'REVIEWED', 'ACTIONED', 'DISMISSED'], default: 'OPEN' },
  reviewedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt:     { type: Date, default: null },
}, { timestamps: true });

// One report per reporter per piece of content.
reportSchema.index({ reporterId: 1, targetType: 1, targetId: 1 }, { unique: true });
// The Safety queue.
reportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('QuestionReport', reportSchema);
module.exports.REASONS = REASONS;
