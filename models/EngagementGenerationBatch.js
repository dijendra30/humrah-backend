// models/EngagementGenerationBatch.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — Phase 2: one document per template-generation
// request (manual or scheduled). Generation history and its outcome.
//
// Holds only the generic request (category, purpose, language, tone, count, limits),
// provider/model, counts, reason codes and timings. Never a prompt with user data
// (there is none), never a provider error message, never a credential.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const attemptSchema = new mongoose.Schema({
  provider:   { type: String, required: true, maxlength: 20 },
  model:      { type: String, default: null, maxlength: 100 },
  outcome:    { type: String, required: true, maxlength: 30 },   // OK | SKIPPED | TRANSIENT | RATE_LIMIT | QUOTA | AUTH | PERMANENT | MALFORMED
  code:       { type: String, default: null, maxlength: 60 },
  httpStatus: { type: Number, default: null },
  durationMs: { type: Number, default: 0 },
  at:         { type: Date, required: true },
}, { _id: false });

const engagementGenerationBatchSchema = new mongoose.Schema({
  trigger:     { type: String, enum: ['MANUAL', 'SCHEDULED'], required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },   // the admin, for MANUAL
  request: {
    category:  { type: String, required: true },
    purpose:   { type: String, required: true },
    language:  { type: String, required: true },
    tone:      { type: String, required: true },
    count:     { type: Number, required: true },
    titleMax:  { type: Number, required: true },
    bodyMax:   { type: Number, required: true },
    variables: { type: [String], default: [] },
  },
  promptHash:    { type: String, required: true, maxlength: 64 },
  promptVersion: { type: Number, required: true },

  status:   { type: String, enum: ['RUNNING', 'SUCCEEDED', 'FAILED'], default: 'RUNNING', required: true },
  provider: { type: String, default: null, maxlength: 20 },    // the provider whose answer was used
  model:    { type: String, default: null, maxlength: 100 },
  attempts: { type: [attemptSchema], default: [] },

  generatedCount: { type: Number, default: 0 },
  acceptedCount:  { type: Number, default: 0 },
  rejectedCount:  { type: Number, default: 0 },
  rejectionReasons: { type: mongoose.Schema.Types.Mixed, default: {} },   // { CODE: n }
  templateIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

  failureReason: { type: String, default: null, maxlength: 60 },
  startedAt:  { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
}, { timestamps: true });

// History listing (newest first).
engagementGenerationBatchSchema.index({ createdAt: -1 });
// "Was this exact request generated recently?" (no tokens spent on identical prompts).
engagementGenerationBatchSchema.index({ promptHash: 1, createdAt: -1 });
// Kept for a year, then removed by Mongo.
engagementGenerationBatchSchema.index({ startedAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

module.exports = mongoose.model('EngagementGenerationBatch', engagementGenerationBatchSchema);
