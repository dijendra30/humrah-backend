// models/MatchingTodayMood.js
// Single collection for Matching Today Mood feature.
// Replaces: live mood state in User.dailyMood + NearbyLocationCache.
// One document per user. Upserted on every app open / Go Live.
'use strict';
const mongoose = require('mongoose');

const nearbyDataSchema = new mongoose.Schema({
  count:  { type: Number, default: 0 },
  places: { type: [String], default: [] }, // top 2-3 place names
}, { _id: false });

const matchingTodayMoodSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────────────────────
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,  // one doc per user
    index: true,
  },

  // ── Live mood state ───────────────────────────────────────────────────────
  mood:       { type: String, default: null },   // "Cafe Mood"
  vibeLevel:  { type: String, default: 'normal' }, // lowkey | normal | social
  intention:  { type: String, default: null },   // optional free-text intent
  visible:    { type: Boolean, default: false },  // false until Go Live

  // ── Location cache key ────────────────────────────────────────────────────
  // "28.70_77.10" — 2-decimal rounded lat/lng grid (~1.1km cell)
  locationHash: { type: String, default: null, index: true },

  // ── Nearby places cache (populated on app open, reused on Go Live) ────────
  nearbyData: { type: nearbyDataSchema, default: () => ({ count: 0, places: [] }) },

  // ── Timestamps ────────────────────────────────────────────────────────────
  updatedAt: { type: Date, default: Date.now },

  // Mood expiry — set to now + 4h on Go Live. null means mood not active.
  expiresAt: { type: Date, default: null },

}, { collection: 'matchingtodaymoods', timestamps: false });

// Compound index for feed queries: visible + not expired
matchingTodayMoodSchema.index({ visible: 1, expiresAt: 1 });
matchingTodayMoodSchema.index({ locationHash: 1, visible: 1 });

module.exports = mongoose.model('MatchingTodayMood', matchingTodayMoodSchema);
