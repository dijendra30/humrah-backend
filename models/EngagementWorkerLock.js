// models/EngagementWorkerLock.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications (Phase 1): a database lease, so only one backend
// instance plans at a time, and the persisted user cursor, so a restart resumes the
// pass instead of starting over.
//
// The lease only avoids duplicated WORK. Correctness never depends on it: the slot
// reservation and the unique idempotency key stop duplicates even if two planners ran.
// Holds aggregate counts only — no user ids other than the pagination cursor.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const engagementWorkerLockSchema = new mongoose.Schema({
  _id: { type: String },                       // 'planner'
  owner: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  cursor: { type: mongoose.Schema.Types.ObjectId, default: null }, // last User _id processed
  cycleStartedAt: { type: Date, default: null },
  cycleCompletedAt: { type: Date, default: null },
  lastRunAt: { type: Date, default: null },
  lastSummary: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

module.exports = mongoose.model('EngagementWorkerLock', engagementWorkerLockSchema);
