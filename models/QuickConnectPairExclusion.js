// models/QuickConnectPairExclusion.js
// -----------------------------------------------------------------------------
// Quick Connect: two people who must not be matched with each other again for a while,
// because one of them skipped (declined) a match between them.
//
// One row per UNORDERED pair: _id is "<smaller id>:<larger id>", so "A skipped B" and
// "B skipped A" are the same row (symmetric) and MongoDB's _id uniqueness makes the
// write atomic. Who skipped is not stored. No profile data.
//
// expiresAt is enforced by every read (expiresAt > now); the TTL index only deletes old
// rows (the TTL monitor runs about once a minute). Written by lifecycle.declineMatch,
// read by matching.tryMatch / pairUp (services/quickConnect/matching.js).
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const REASONS = ['declined'];

const exclusionSchema = new mongoose.Schema({
  _id:       { type: String },                                                   // pairKey(a, b)
  users:     { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], required: true },   // sorted pair
  reason:    { type: String, enum: REASONS, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, required: true }
}, { versionKey: false, collection: 'quickconnectpairexclusions' });

exclusionSchema.index({ users: 1 });
exclusionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** The pair's key, the same whichever order the two ids come in. */
function pairKey(a, b) {
  return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join(':');
}

exclusionSchema.statics.pairKey = pairKey;
exclusionSchema.statics.REASONS = REASONS;

module.exports = mongoose.models.QuickConnectPairExclusion || mongoose.model('QuickConnectPairExclusion', exclusionSchema);
