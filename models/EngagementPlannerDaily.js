// models/EngagementPlannerDaily.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — Phase 3: what the planner decided, counted per
// Asia/Kolkata day (one document per day, _id 'YYYY-MM-DD'). Written with one $inc
// upsert per planner batch — counts only, no user ids.
//
//   evaluated  users the planner looked at
//   queued     notifications queued (deferred = of those, scheduled after quiet hours)
//   evaluationErrors  users whose evaluation threw
//   skipped    { REASON_CODE: n } — the Phase 1 skip codes (FREQUENCY_WINDOW,
//              ENGAGEMENT_DISABLED, NO_OPPORTUNITY, NO_VALID_DEVICE, …)
// Kept 400 days.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const engagementPlannerDailySchema = new mongoose.Schema({
  _id: { type: String },                        // 'YYYY-MM-DD' (Asia/Kolkata)
  day: { type: Date, required: true },          // 00:00 IST of that day, for range queries + TTL
  evaluated: { type: Number, default: 0 },
  queued: { type: Number, default: 0 },
  deferred: { type: Number, default: 0 },
  evaluationErrors: { type: Number, default: 0 },
  skipped: { type: mongoose.Schema.Types.Mixed, default: {} },
  categories: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false });

engagementPlannerDailySchema.index({ day: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

module.exports = mongoose.model('EngagementPlannerDaily', engagementPlannerDailySchema);
