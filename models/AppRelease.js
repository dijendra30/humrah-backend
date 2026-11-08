// models/AppRelease.js
// -----------------------------------------------------------------------------
// App Update Management — one document per app release (Android today).
//
// Life cycle:  DRAFT → SCHEDULED → PUBLISHED → PAUSED ⇄ PUBLISHED
//                   ↘ PUBLISHED                ↘ WITHDRAWN (final)
//              a newer published release turns the old one SUPERSEDED.
// At most one release per platform is PUBLISHED (unique partial index). Nothing is
// ever deleted: withdrawn / superseded releases stay as history, and every change is
// kept in `changeLog` (and in the shared AuditLog).
//
// Update decisions use the numeric versionCode only (never the versionName string).
// "Mandatory" is not a policy an admin picks: it follows from minimumSupportedVersionCode
// (services/appUpdates/appUpdatePolicy.js).
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const PLATFORMS = Object.freeze(['ANDROID']);
const UPDATE_POLICIES = Object.freeze(['OPTIONAL', 'RECOMMENDED', 'CRITICAL']);
const STATUSES = Object.freeze(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'PAUSED', 'WITHDRAWN', 'SUPERSEDED']);
const ROLLOUT_STEPS = Object.freeze([10, 25, 50, 75, 100]);
const MAX_VERSION_CODE = 2100000000; // Google Play's ceiling for versionCode

const changeSchema = new mongoose.Schema({
  at:      { type: Date, default: Date.now },
  by:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byEmail: { type: String, maxlength: 254 },
  action:  { type: String, maxlength: 40 },
  reason:  { type: String, maxlength: 300 },
  changes: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { _id: false });

const appReleaseSchema = new mongoose.Schema({
  platform:    { type: String, enum: PLATFORMS, required: true, default: 'ANDROID', index: true },
  versionName: { type: String, required: true, trim: true, maxlength: 32 },
  versionCode: { type: Number, required: true, min: 1, max: MAX_VERSION_CODE, validate: Number.isInteger },
  minimumSupportedVersionCode: {
    type: Number, required: true, min: 1, max: MAX_VERSION_CODE, validate: Number.isInteger,
  },

  releaseTitle:       { type: String, required: true, trim: true, maxlength: 80 },
  releaseDescription: { type: String, trim: true, maxlength: 300, default: '' },
  releaseNotes:       { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },

  updatePolicy: { type: String, enum: UPDATE_POLICIES, required: true, default: 'OPTIONAL' },
  status:       { type: String, enum: STATUSES, required: true, default: 'DRAFT', index: true },
  rolloutPercentage: { type: Number, enum: ROLLOUT_STEPS, required: true, default: 100 },
  playStoreUrl: { type: String, required: true, maxlength: 300 },

  // Reminders for OPTIONAL / RECOMMENDED / CRITICAL prompts (never for a mandatory update).
  reminderCooldownHours: { type: Number, min: 1, max: 720, default: 72, validate: Number.isInteger },
  maxReminders:          { type: Number, min: 1, max: 20, default: 5, validate: Number.isInteger },
  allowPostponement:     { type: Boolean, default: true },

  scheduledAt:      { type: Date, default: null },
  scheduleTimeZone: { type: String, maxlength: 64, default: null }, // IANA name, for display only
  publishedAt:  { type: Date, default: null },
  pausedAt:     { type: Date, default: null },
  withdrawnAt:  { type: Date, default: null },
  supersededAt: { type: Date, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changeLog: { type: [changeSchema], default: [] },
}, { timestamps: true });

// One live release per platform: the database refuses a second PUBLISHED one.
appReleaseSchema.index(
  { platform: 1 },
  { unique: true, partialFilterExpression: { status: 'PUBLISHED' }, name: 'one_published_per_platform' }
);
appReleaseSchema.index({ platform: 1, status: 1, scheduledAt: 1 });
appReleaseSchema.index({ platform: 1, versionCode: -1 });

appReleaseSchema.path('minimumSupportedVersionCode').validate(function (v) {
  return typeof this.versionCode !== 'number' || v <= this.versionCode;
}, 'minimumSupportedVersionCode must not be above versionCode');

module.exports = mongoose.models.AppRelease || mongoose.model('AppRelease', appReleaseSchema);
module.exports.PLATFORMS = PLATFORMS;
module.exports.UPDATE_POLICIES = UPDATE_POLICIES;
module.exports.STATUSES = STATUSES;
module.exports.ROLLOUT_STEPS = ROLLOUT_STEPS;
module.exports.MAX_VERSION_CODE = MAX_VERSION_CODE;
