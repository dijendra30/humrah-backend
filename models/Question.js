// models/Question.js
// -----------------------------------------------------------------------------
// Ask a Question — a short local question (services/questionService.js).
//
//   status   ACTIVE    open for answers until expiresAt (24 h). Past expiresAt it is
//                      treated as EXPIRED everywhere, before the cron even flips it.
//            CLOSED    the asker closed it; read-only, no reopening (MVP)
//            EXPIRED   24 h passed (cron, idempotent); read-only
//            DELETED   the asker deleted it (soft: kept, never listed or shown)
//            HIDDEN    hidden by Safety (admin); not listed, read-only for the asker
//   There is no ANSWERED status: answers do not change the state (answerCount > 0).
//
// LOCATION: only locationGrid — the asker's position at posting time snapped to the centre
// of a ~1 km grid cell (never the exact point). It is used for "within 10 km" and for a
// coarse distance band, and is never sent to any client.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const { CATEGORIES } = require('../services/questions/questionRules');

const STATUSES = ['ACTIVE', 'CLOSED', 'EXPIRED', 'DELETED', 'HIDDEN'];

const questionSchema = new mongoose.Schema({
  askerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String, enum: CATEGORIES, required: true },
  text:     { type: String, required: true, maxlength: 4000 },   // 180 graphemes (an emoji can be many code units)
  tags:     { type: [String], default: [] },
  status:   { type: String, enum: STATUSES, default: 'ACTIVE', required: true },
  locationGrid: {
    type:        { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },      // [lng, lat] of the grid-cell centre
  },
  expiresAt: { type: Date, required: true },
  closedAt:  { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  statusBeforeDelete: { type: String, default: null },
  statusBeforeHide:   { type: String, default: null },        // what an admin "restore" returns it to
  hiddenAt:  { type: Date, default: null },
  hiddenBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },   // the admin
  hiddenReason: { type: String, default: null, maxlength: 200 },
  answerCount: { type: Number, default: 0, min: 0 },
  // ── Admin / analytics (never sent to the app) ──
  // ALLOWED      passed automated moderation (every stored question did)
  // FLAGGED      reported at least once and not yet reviewed
  // UNDER_REVIEW an admin is looking at a report about it
  // REVIEWED     an admin reviewed it (kept, hidden or restored — see status)
  moderationState: { type: String, enum: ['ALLOWED', 'FLAGGED', 'UNDER_REVIEW', 'REVIEWED'], default: 'ALLOWED' },
  reportCount:     { type: Number, default: 0, min: 0 },
  lastReportedAt:  { type: Date, default: null },
  firstAnswerAt:   { type: Date, default: null },
  timeToFirstAnswerMs: { type: Number, default: null },        // firstAnswerAt − createdAt, for sorting
  restoredFromRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },   // admin overturned an automated rejection
  // Idempotency: the client's key for this create. A retry with the same key returns this question.
  clientRequestId: { type: String, default: undefined },
  // Duplicate detection only (lowercased, punctuation-free). Never returned.
  normalizedText: { type: String, select: false },
  // Phase 4 — "Someone answered your question" pushes to the asker (services/questions/
  // questionNotifications.js). At most one push per question per window; answers that
  // arrive inside it wait here and the every-minute tick sends them as one ("3 new
  // answers"). Never sent to the app.
  answerPush: {
    lastSentAt:   { type: Date, default: null },
    pendingCount: { type: Number, default: 0 },
    pendingSince: { type: Date, default: null },   // when the first waiting answer was queued
  },
}, { timestamps: true });

// Discovery: nearby + ACTIVE + not expired ($geoNear on locationGrid).
questionSchema.index({ locationGrid: '2dsphere', status: 1, expiresAt: 1 });
// The asker's active questions (limit of 2) and own lists.
questionSchema.index({ askerId: 1, status: 1, expiresAt: 1 });
// The asker's recent questions (duplicate window).
questionSchema.index({ askerId: 1, createdAt: -1 });
// Expiry cron: ACTIVE whose expiresAt passed.
questionSchema.index({ status: 1, expiresAt: 1 });
// Idempotency: one question per (asker, client key).
questionSchema.index({ askerId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
// Admin dashboard: lists, sorts and period analytics.
questionSchema.index({ createdAt: -1 });
questionSchema.index({ category: 1, createdAt: -1 });
questionSchema.index({ reportCount: -1, createdAt: -1 });
questionSchema.index({ lastReportedAt: -1 }, { partialFilterExpression: { lastReportedAt: { $type: 'date' } } });
questionSchema.index({ timeToFirstAnswerMs: 1 }, { partialFilterExpression: { timeToFirstAnswerMs: { $type: 'number' } } });
questionSchema.index({ moderationState: 1, createdAt: -1 });
// Admin text search on the question.
questionSchema.index({ text: 'text' }, { default_language: 'none' });
// Phase 4: the answer-push tick — only questions with answers waiting to be announced.
questionSchema.index({ 'answerPush.lastSentAt': 1 }, { partialFilterExpression: { 'answerPush.pendingCount': { $gt: 0 } } });

module.exports = mongoose.model('Question', questionSchema);
module.exports.STATUSES = STATUSES;
