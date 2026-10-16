// models/QuickConnectReport.js
// -----------------------------------------------------------------------------
// Quick Connect: "this reporter already reported this session". _id is
// "<sessionId>:<reporterId>", so a repeated or simultaneous report files only one
// SafetyReport (the real moderation record, which the admin dashboard reads and which
// this marker only points to). Removed with the session's 30-day retention.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const reportMarkerSchema = new mongoose.Schema({
  _id:            { type: String },
  sessionId:      { type: mongoose.Schema.Types.ObjectId, ref: 'QuickConnectSession', required: true },
  reporterId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  safetyReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'SafetyReport', default: null },
  createdAt:      { type: Date, required: true }
}, { versionKey: false, collection: 'quickconnectreports' });

reportMarkerSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.models.QuickConnectReport || mongoose.model('QuickConnectReport', reportMarkerSchema);
