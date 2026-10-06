// models/QuestionAuditLog.js
// -----------------------------------------------------------------------------
// Ask a Question audit trail: ids and codes only — never question/answer text, never
// coordinates. Kept 180 days (TTL). System and admin events; the existing AuditLog is
// admin-actions-only (actorRole must be an admin role), so it does not fit system events.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const EVENTS = [
  'QUESTION_CREATED', 'QUESTION_CLOSED', 'QUESTION_EXPIRED', 'QUESTION_DELETED',
  'QUESTION_MODERATION_REJECTED', 'QUESTION_RESTRICTION_APPLIED', 'QUESTION_RESTRICTION_LIFTED',
  'QUESTION_REPORT_CREATED', 'QUESTION_HIDDEN', 'QUESTION_HIDDEN_BY_ADMIN', 'QUESTION_UNHIDDEN_BY_ADMIN',
  'ANSWER_CREATED', 'ANSWER_REJECTED', 'ANSWER_DELETED', 'REPLY_CREATED', 'REPLY_REJECTED',
  // Phase 4 pushes (ids and counts only).
  'QUESTION_ANSWER_NOTIFIED', 'QUESTION_REPLY_NOTIFIED',
];

const auditSchema = new mongoose.Schema({
  event:        { type: String, enum: EVENTS, required: true },
  actorId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },   // null = system
  questionId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  answerId:     { type: mongoose.Schema.Types.ObjectId, default: null },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
  meta:         { type: mongoose.Schema.Types.Mixed, default: null },                  // codes and counts only
  createdAt:    { type: Date, default: Date.now },
});

auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
auditSchema.index({ event: 1, createdAt: -1 });
auditSchema.index({ questionId: 1, createdAt: -1 });

module.exports = mongoose.model('QuestionAuditLog', auditSchema);
module.exports.EVENTS = EVENTS;
