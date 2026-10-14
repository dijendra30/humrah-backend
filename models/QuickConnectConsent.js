// models/QuickConnectConsent.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 4): one immutable record per (user, consent version) the
// user accepted through POST /api/quick-connect/consent.
//
// Kept apart from User on purpose: no change to the users collection, and it is
// separate from general Terms/Privacy (LegalAcceptance) and from the onboarding
// questionnaire's consentAccepted flag. When QUICK_CONNECT_CONSENT_VERSION moves
// on, older records simply no longer match — nothing is rewritten.
//
// Minimal data: who, which version, when. No IP address, device or user agent.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const consentSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  version:    { type: String, required: true, immutable: true, maxlength: 32 },
  acceptedAt: { type: Date, required: true, default: Date.now, immutable: true }
}, { versionKey: false, collection: 'quickconnectconsents' });

// One record per user and version; also the lookup index for eligibility.
consentSchema.index({ userId: 1, version: 1 }, { unique: true });

module.exports = mongoose.models.QuickConnectConsent || mongoose.model('QuickConnectConsent', consentSchema);
