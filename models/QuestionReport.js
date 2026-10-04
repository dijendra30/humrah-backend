// models/QuestionReport.js
// -----------------------------------------------------------------------------
// A report of a question, answer or reply — the same per-content pattern as UserReport,
// PostReport and LetterReport. Reporting hides the content from the reporter only and
// queues it for review. It NEVER restricts, suspends or bans anyone by itself: every
// decision below is an admin's, recorded with who, when, why (and in the AuditLog).
//
//   status      OPEN → UNDER_REVIEW → RESOLVED | DISMISSED
//   resolution  (RESOLVED only) VIOLATION_CONFIRMED | NO_VIOLATION
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const REASONS = ['OFFENSIVE', 'SPAM_OR_CONTACT', 'HARASSMENT', 'UNSAFE', 'MISLEADING', 'OTHER'];
const STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
const RESOLUTIONS = ['VIOLATION_CONFIRMED', 'NO_VIOLATION'];

const reportSchema = new mongoose.Schema({
  reporterId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetType:     { type: String, enum: ['QUESTION', 'ANSWER', 'REPLY'], required: true },
  targetId:       { type: mongoose.Schema.Types.ObjectId, required: true },
  questionId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category:       { type: String, default: null },        // the question's category (analytics)
  reason:         { type: String, enum: REASONS, required: true },
  description:    { type: String, default: '', maxlength: 500 },
  status:         { type: String, enum: STATUSES, default: 'OPEN' },
  resolution:     { type: String, enum: [...RESOLUTIONS, null], default: null },
  assignedTo:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },   // the admin who took it
  reviewedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt:     { type: Date, default: null },
  resolvedAt:     { type: Date, default: null },     // RESOLVED or DISMISSED
  adminReason:    { type: String, default: null, maxlength: 300 },
  adminNote:      { type: String, default: null, maxlength: 1000 },                        // internal only
  escalated:      { type: Boolean, default: false },
  escalatedAt:    { type: Date, default: null },
  escalatedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// One report per reporter per piece of content.
reportSchema.index({ reporterId: 1, targetType: 1, targetId: 1 }, { unique: true });
// The review queue.
reportSchema.index({ status: 1, createdAt: -1 });
// Analytics over time and related reports.
reportSchema.index({ createdAt: -1 });
reportSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
reportSchema.index({ reportedUserId: 1, createdAt: -1 });
reportSchema.index({ questionId: 1, createdAt: -1 });

module.exports = mongoose.model('QuestionReport', reportSchema);
module.exports.REASONS = REASONS;
module.exports.STATUSES = STATUSES;
module.exports.RESOLUTIONS = RESOLUTIONS;
