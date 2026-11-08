// models/EngagementAiProviderState.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — Phase 2: shared health and budget of each AI
// provider ('gemini', 'groq'). In the database, so cooldowns, daily request counts and
// the minimum spacing between requests hold across restarts and several instances.
// Holds reason CODES only — never a provider message, a request, or a credential.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const engagementAiProviderStateSchema = new mongoose.Schema({
  _id: { type: String },                          // provider name
  cooldownUntil:  { type: Date, default: null },
  cooldownReason: { type: String, default: null, maxlength: 30 },
  consecutiveFailures: { type: Number, default: 0 },
  lastSuccessAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  lastFailureCode: { type: String, default: null, maxlength: 60 },
  dayKey: { type: String, default: null },        // UTC day of requestsToday
  requestsToday: { type: Number, default: 0 },
  lastRequestAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('EngagementAiProviderState', engagementAiProviderStateSchema);
