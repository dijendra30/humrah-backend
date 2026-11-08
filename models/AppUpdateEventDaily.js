// models/AppUpdateEventDaily.js
// -----------------------------------------------------------------------------
// Counters for update prompts: how often each release's prompt was shown, tapped,
// dismissed or postponed, per Asia/Kolkata day. Counts only — no user ids, so the
// dashboard's prompt analytics can never point at a person.
// A tap on "Update" is NOT an install: adoption comes from AppVersionTelemetry.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const EVENTS = Object.freeze(['IMPRESSION', 'CLICK', 'DISMISS', 'POSTPONE']);
const UPDATE_TYPES = Object.freeze(['OPTIONAL', 'RECOMMENDED', 'CRITICAL', 'MANDATORY']);

const appUpdateEventDailySchema = new mongoose.Schema({
  releaseId:  { type: mongoose.Schema.Types.ObjectId, ref: 'AppRelease', required: true },
  day:        { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // Asia/Kolkata calendar day
  event:      { type: String, enum: EVENTS, required: true },
  updateType: { type: String, enum: UPDATE_TYPES, required: true },
  count:      { type: Number, default: 0, min: 0 },
}, { timestamps: false });

appUpdateEventDailySchema.index({ releaseId: 1, day: 1, event: 1, updateType: 1 }, { unique: true });

module.exports = mongoose.models.AppUpdateEventDaily || mongoose.model('AppUpdateEventDaily', appUpdateEventDailySchema);
module.exports.EVENTS = EVENTS;
module.exports.UPDATE_TYPES = UPDATE_TYPES;
