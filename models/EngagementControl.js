// models/EngagementControl.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — Phase 3: operator switches that live in the
// DATABASE (one document, _id 'global'), so an admin can stop delivery on every backend
// instance at once without a redeploy.
//
// These switches can only make the system do LESS than the environment allows:
//   deliveryStopped   true → the worker plans nothing and sends nothing (emergency stop).
//                     Queued notifications and templates are kept untouched.
//   aiPaused          true → no AI provider is called (manual or scheduled generation).
//                     Delivery with already ACTIVE templates continues.
// ENGAGEMENT_WORKER_ENABLED / ENGAGEMENT_AI_ENABLED stay the master switches; nothing here
// can turn on what the environment has turned off.
// `history` keeps the last 50 changes (who, when, why) next to the switch itself.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const changeSchema = new mongoose.Schema({
  action: { type: String, enum: ['DELIVERY_STOPPED', 'DELIVERY_RESUMED', 'AI_PAUSED', 'AI_RESUMED'], required: true },
  by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byEmail: { type: String, default: null, maxlength: 200 },
  reason: { type: String, default: null, maxlength: 300 },
  at:     { type: Date, required: true },
}, { _id: false });

const engagementControlSchema = new mongoose.Schema({
  _id: { type: String },                       // 'global'
  deliveryStopped: { type: Boolean, default: false },
  deliveryStoppedAt: { type: Date, default: null },
  deliveryStoppedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deliveryStopReason: { type: String, default: null, maxlength: 300 },
  aiPaused: { type: Boolean, default: false },
  aiPausedAt: { type: Date, default: null },
  aiPausedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  history: { type: [changeSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('EngagementControl', engagementControlSchema);
