// models/SportsDiscoveryDelivery.js
// -----------------------------------------------------------------------------
// Sports discovery (Phase 5C) — one row per (plan, user): "we invited this person
// to this plan". It is the duplicate guard, the input to the frequency caps, the
// retry state and the audit trail (SPORTS_PHASE_5B_TECHNICAL_PLAN.md §6, §16).
//
// The row is INSERTED BEFORE the push is sent (status 'sending'). The unique
// (sportsPlanId, userId) index means a second cron run, a second server or a retry
// of the selection can never create a second row, so never a second push.
//
//   sending           inserted; the push is in flight or its outcome is unknown.
//                     Older than SPORTS_DISCOVERY_UNCERTAIN_MIN = "possibly
//                     delivered": never resent. Counts toward the caps.
//   sent              FCM accepted it. Counts toward the caps.
//   failed_retryable  first attempt was not delivered; ONE retry is allowed until
//                     retryUntil. Does not count.
//   failed            final. Does not count.
//   skipped           inserted but deliberately not sent (lost a cap race, the
//                     plan or the person changed). Does not count.
//
// claimedAt is when the row was inserted: every cap window counts from it.
// Only ids and states — no tokens, coordinates or distances.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const STATUSES = ['sending', 'sent', 'failed_retryable', 'failed', 'skipped'];
// The states that count toward a person's caps.
const COUNTED = ['sending', 'sent'];

const sportsDiscoveryDeliverySchema = new mongoose.Schema({
  sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Denormalised so the 7-day creator cooldown needs no plan lookup.
  creatorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:       { type: String, enum: STATUSES, required: true },
  claimedAt:    { type: Date, required: true },
  sentAt:       { type: Date, default: null },
  attempts:     { type: Number, default: 1 },
  retryAfter:   { type: Date, default: null },
  retryUntil:   { type: Date, default: null },
  skipReason:   { type: String, default: null },
}, { timestamps: true });

// The mandatory once-per-(plan, user) guard.
sportsDiscoveryDeliverySchema.index({ sportsPlanId: 1, userId: 1 }, { unique: true });
// All the caps (60 min / 24 h / same creator 7 days) read one person's recent rows.
sportsDiscoveryDeliverySchema.index({ userId: 1, claimedAt: -1 });
// The retry pass and the expiry sweep. Partial, so it only ever holds the few rows
// that are waiting for their one retry.
sportsDiscoveryDeliverySchema.index(
  { retryUntil: 1 },
  { partialFilterExpression: { status: 'failed_retryable' } },
);
// Housekeeping. Caps look back 7 days and a plan is announced within 30 minutes of
// its creation, so an expired row can never allow a repeat for the same plan.
sportsDiscoveryDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.model('SportsDiscoveryDelivery', sportsDiscoveryDeliverySchema);
module.exports.STATUSES = STATUSES;
module.exports.COUNTED = COUNTED;
