// models/EngagementTemplate.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — Phase 2: reusable notification templates
// (AI-generated or admin-revised). One document per (templateId, version).
//
// Content is IMMUTABLE once stored: title, body, variables and contentHash are never
// updated. A revision is a NEW document with the same templateId and version + 1
// (services/engagement/templateStore.revise). Queued notifications store the rendered
// text, so no template change can alter a notification already in the queue.
//
// Lifecycle (one `status` field; approval metadata sits beside it, so there is no
// second "approvalStatus" that could disagree):
//
//   DRAFT ──approve──▶ APPROVED ──activate──▶ ACTIVE ◀──activate── PAUSED
//     │                   │                    └──pause──▶ PAUSED
//     └──reject──▶ REJECTED ◀──reject──┘
//   any non-archived ──archive──▶ ARCHIVED (terminal)
//
// Only ACTIVE templates are ever loaded by the Phase 1 worker.
// No user data: templates are generic copy with {{placeholders}}.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const { CATEGORIES } = require('../config/engagementNotificationConfig');
const { LANGUAGES, TONES } = require('../config/engagementAiConfig');

const STATUSES = Object.freeze(['DRAFT', 'APPROVED', 'ACTIVE', 'PAUSED', 'ARCHIVED', 'REJECTED']);

const engagementTemplateSchema = new mongoose.Schema({
  templateId: { type: String, required: true, maxlength: 80 },
  version:    { type: Number, required: true, min: 1 },
  parentVersion: { type: Number, default: null },

  category: { type: String, enum: CATEGORIES, required: true },
  purpose:  { type: String, required: true, maxlength: 40 },
  language: { type: String, enum: LANGUAGES, required: true },
  tone:     { type: String, enum: TONES, required: true },

  title:     { type: String, required: true, maxlength: 200 },
  body:      { type: String, required: true, maxlength: 400 },
  variables: { type: [String], default: [] },
  contentHash: { type: String, required: true, maxlength: 64 },
  validationVersion: { type: Number, default: 1 },

  source:   { type: String, enum: ['AI', 'ADMIN'], required: true },
  provider: { type: String, default: null, maxlength: 20 },
  model:    { type: String, default: null, maxlength: 100 },
  generationBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'EngagementGenerationBatch', default: null },

  status: { type: String, enum: STATUSES, default: 'DRAFT', required: true },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  rejectedAt: { type: Date, default: null },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  rejectionReason: { type: String, default: null, maxlength: 200 },
  activatedAt: { type: Date, default: null },
  pausedAt:    { type: Date, default: null },
  archivedAt:  { type: Date, default: null },
  statusChangedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Usage = notifications QUEUED with this template version (Phase 1 analytics hold the rest).
  usageCount: { type: Number, default: 0, min: 0 },
  lastUsedAt: { type: Date, default: null },
  // Refreshed from engagementnotifications (aggregate counts only).
  performanceMetadata: {
    queued:        { type: Number, default: 0 },
    fcmAccepted:   { type: Number, default: 0 },
    opened:        { type: Number, default: 0 },
    featureOpened: { type: Number, default: 0 },
    refreshedAt:   { type: Date, default: null },
  },
}, { timestamps: true });

// One document per version.
engagementTemplateSchema.index({ templateId: 1, version: 1 }, { unique: true });
// The worker's pool load: ACTIVE templates (and admin listing by status).
engagementTemplateSchema.index({ status: 1, category: 1, purpose: 1, language: 1 });
// Duplicate prevention: the same normalised copy can exist once per category + language,
// whatever its status (so a rejected text is never re-added by a later batch).
engagementTemplateSchema.index({ category: 1, language: 1, contentHash: 1 }, { unique: true });
// Templates of one generation batch.
engagementTemplateSchema.index({ generationBatchId: 1 }, { partialFilterExpression: { generationBatchId: { $type: 'objectId' } } });

const EngagementTemplate = mongoose.model('EngagementTemplate', engagementTemplateSchema);
module.exports = EngagementTemplate;
module.exports.STATUSES = STATUSES;
