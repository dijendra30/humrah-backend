// models/AppVersionTelemetry.js
// -----------------------------------------------------------------------------
// The installed app version each signed-in user last reported, written by the update
// check (GET /api/app-updates/android). One document per user and platform; nothing
// about the device beyond the app's own versionCode / versionName.
//
// `history` keeps each version change (oldest first, capped) so the dashboard can show
// adoption over time from what users actually run — not from Play Store clicks.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const HISTORY_CAP = 20;

const appVersionTelemetrySchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  platform:    { type: String, enum: ['ANDROID'], required: true, default: 'ANDROID' },
  versionCode: { type: Number, required: true, min: 1 },
  versionName: { type: String, maxlength: 32, default: null },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now, index: true },
  history: {
    type: [{ _id: false, versionCode: Number, at: Date }],
    default: [],
  },
}, { timestamps: false });

appVersionTelemetrySchema.index({ userId: 1, platform: 1 }, { unique: true });
appVersionTelemetrySchema.index({ platform: 1, versionCode: 1, lastSeenAt: -1 });

module.exports = mongoose.models.AppVersionTelemetry || mongoose.model('AppVersionTelemetry', appVersionTelemetrySchema);
module.exports.HISTORY_CAP = HISTORY_CAP;
