// models/QuickConnectSearch.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 5): a user who is SEARCHING for a match. The document's _id IS
// the user's id, so MongoDB's _id uniqueness makes "one search per user" atomic: a
// second simultaneous start cannot insert a second row.
//
//   SEARCHING  waiting; may be picked by a matcher
//   PAIRING    claimed by one matcher (pairingToken) while it re-checks eligibility and
//              reserves both users; returns to SEARCHING or is deleted
// A successful match deletes both rows (the session takes over). Cancel deletes the row.
//
// Holds only normalized interest labels (the same predefined option strings the app
// stores) — no name, location or other profile data.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const searchSchema = new mongoose.Schema({
  _id:          { type: mongoose.Schema.Types.ObjectId, ref: 'User' },   // the searching user
  status:       { type: String, enum: ['SEARCHING', 'PAIRING'], required: true, default: 'SEARCHING' },
  interests:    { type: [String], default: [] },
  startedAt:    { type: Date, required: true },
  broadenAt:    { type: Date, required: true },     // after this, any eligible user may match
  expiresAt:    { type: Date, required: true },     // search timeout (and TTL garbage collection)
  pairingToken: { type: String, default: null },
  pairingAt:    { type: Date, default: null }
}, { versionKey: false, collection: 'quickconnectsearches' });

searchSchema.index({ status: 1, startedAt: 1 });
searchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });   // rows are normally removed long before

module.exports = mongoose.models.QuickConnectSearch || mongoose.model('QuickConnectSearch', searchSchema);
