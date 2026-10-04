// models/QuestionModerationRecord.js
// -----------------------------------------------------------------------------
// Text that automated moderation refused (a question, answer or reply), kept so an admin
// can review the decision — confirm it, or overturn it (a false positive: the content is
// then published as the person wrote it). This is what makes false-positive review
// possible, which matters for Hindi, Hinglish, slang and abbreviations.
//
// The refused text is personal content, so it is kept only as long as review needs:
// 90 days (TTL). It is visible to admins only, never to the app. No coordinates: for a
// refused question only the ~1 km grid cell it would have had is kept (needed to restore
// it); the admin API never returns it.
//
//   status  PENDING_REVIEW → CONFIRMED (admin agrees) | OVERTURNED (admin restored the content)
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const STATUSES = ['PENDING_REVIEW', 'CONFIRMED', 'OVERTURNED'];

const recordSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentType: { type: String, enum: ['QUESTION', 'ANSWER', 'REPLY'], required: true },
  questionId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },   // answers / replies
  answerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionAnswer', default: null }, // replies
  category:    { type: String, default: null },
  tags:        { type: [String], default: [] },
  text:        { type: String, required: true, maxlength: 4000 },
  locationGrid: {                                 // refused questions only, to restore them
    type:        { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined },
  },
  verdict:     { type: String, enum: ['BLOCKED', 'REVIEW'], required: true },
  reasonCode:  { type: String, required: true },
  severity:    { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], required: true },
  restrictionApplied: {
    level: { type: Number, default: null },
    until: { type: Date, default: null },
    final: { type: Boolean, default: false },
  },
  status:      { type: String, enum: STATUSES, default: 'PENDING_REVIEW' },
  reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt:  { type: Date, default: null },
  adminReason: { type: String, default: null, maxlength: 300 },
  adminNote:   { type: String, default: null, maxlength: 1000 },
  restoredContentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdAt:   { type: Date, default: Date.now },
});

recordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
recordSchema.index({ status: 1, createdAt: -1 });
recordSchema.index({ userId: 1, createdAt: -1 });
recordSchema.index({ contentType: 1, createdAt: -1 });

module.exports = mongoose.model('QuestionModerationRecord', recordSchema);
module.exports.STATUSES = STATUSES;
