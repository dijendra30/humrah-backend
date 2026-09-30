// models/SportsDiscoveryControl.js
// -----------------------------------------------------------------------------
// Sports discovery (Phase 5D) — ONE document (_id 'global') holding the feature's own
// operating state, so it survives a restart and an operator can read it without database
// access (GET /api/admin/sports-discovery/status):
//
//   the circuit breaker   trippedAt / tripReason. When discovery detects a critical
//                         failure (a cap breach, Firebase failing for every send, a
//                         payload that is not the agreed eight keys, ten minutes of
//                         continuous errors) it writes this and STOPS. It stays stopped,
//                         across restarts, until SPORTS_DISCOVERY_STARTED_AT is set to a
//                         time AFTER trippedAt. Re-arming therefore needs a deliberate
//                         configuration change, and (because plans created before the new
//                         start time are never announced) it can never re-announce the
//                         plans that were skipped while it was stopped.
//   the last tick         counts only (no ids, no tokens, no coordinates).
//
// Nothing here is ever sent to a client except through that read-only status route.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const KEY = 'global';

const sportsDiscoveryControlSchema = new mongoose.Schema({
  _id: { type: String },
  // The breaker. Both are cleared (and copied to lastTrip) when a later start time re-arms it.
  trippedAt:  { type: Date, default: null },
  tripReason: { type: String, default: null },
  tripDetail: { type: mongoose.Schema.Types.Mixed, default: null },
  lastTrip:   { type: mongoose.Schema.Types.Mixed, default: null },
  rearmedAt:  { type: Date, default: null },
  // Ticks in a row that reported at least one error.
  consecutiveErrorTicks: { type: Number, default: 0 },
  lastTickAt:      { type: Date, default: null },
  lastTick:        { type: mongoose.Schema.Types.Mixed, default: null },
  lastHeartbeatAt: { type: Date, default: null },
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('SportsDiscoveryControl', sportsDiscoveryControlSchema);
module.exports.KEY = KEY;
