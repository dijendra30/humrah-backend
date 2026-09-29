// models/SportsDiscoveryRun.js
// -----------------------------------------------------------------------------
// Sports discovery (Phase 5C) — one row per Sports plan whose "plan near you"
// pushes are being, or have been, sent. It is the per-plan claim and the record of
// WHO was chosen (SPORTS_PHASE_5B_TECHNICAL_PLAN.md §7).
//
//   SportsPlan ──1:0..1── SportsDiscoveryRun ──1:n── SportsDiscoveryDelivery
//
// sportsPlanId is unique, so however many times the cron runs, on however many
// servers, a plan has one Run. Claiming it is a conditional update on this row
// (leaseUntil in the past), so two workers never process one plan at once, and a
// worker that dies simply lets its lease lapse: the next tick takes over.
//
// recipients is chosen ONCE (selectedAt) and reused by every later claim. A resumed
// run therefore never recomputes who to notify — it cannot exceed the per-plan
// limit or pick different people. Only user ids are kept: no coordinates, no
// distances.
//
// SportsPlan is not touched.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const STATUSES = ['processing', 'done'];
const DONE_REASONS = ['completed', 'no_recipients', 'plan_ineligible', 'abandoned'];

const sportsDiscoveryRunSchema = new mongoose.Schema({
  sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  status:       { type: String, enum: STATUSES, default: 'processing', required: true },
  // The claim: a worker owns the plan while now < leaseUntil.
  leaseUntil:   { type: Date, default: null },
  // How many times the plan has been claimed (a crash-loop guard: capped).
  attempts:     { type: Number, default: 0 },
  // The chosen recipients. Set once, together with selectedAt.
  recipients:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  selectedAt:   { type: Date, default: null },
  doneReason:   { type: String, enum: [...DONE_REASONS, null], default: null },
  // Small aggregate numbers only (for the one log line and for support).
  counts: {
    candidates: { type: Number, default: 0 },
    eligible:   { type: Number, default: 0 },
    selected:   { type: Number, default: 0 },
    sent:       { type: Number, default: 0 },
    failed:     { type: Number, default: 0 },
    skipped:    { type: Number, default: 0 },
  },
}, { timestamps: true });

// One Run per plan — the idempotency key.
sportsDiscoveryRunSchema.index({ sportsPlanId: 1 }, { unique: true });
// Housekeeping: a Run is only useful while its plan can still be announced.
sportsDiscoveryRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.model('SportsDiscoveryRun', sportsDiscoveryRunSchema);
module.exports.STATUSES = STATUSES;
module.exports.DONE_REASONS = DONE_REASONS;
