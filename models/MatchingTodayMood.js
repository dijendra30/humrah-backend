// models/MatchingTodayMood.js
// One document per user — stores ONLY live mood state + locationHash.
// Nearby data is NO LONGER stored here; use NearbyAreaCache instead.
'use strict';
const mongoose = require('mongoose');

const matchingTodayMoodSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  // Live mood state
  mood:         { type: String, default: null },
  vibeLevel:    { type: String, enum: ['lowkey', 'normal', 'social'], default: 'normal' },
  intention:    { type: String, default: null },
  visible:      { type: Boolean, default: false },

  // Location reference — points into NearbyAreaCache
  locationHash: { type: String, default: null, index: true },

  updatedAt:    { type: Date, default: Date.now },
  expiresAt:    { type: Date, default: null },
}, {
  collection: 'matchingtodaymoods',
  timestamps: false,
});

matchingTodayMoodSchema.index({ visible: 1, expiresAt: 1 });
matchingTodayMoodSchema.index({ locationHash: 1, visible: 1 });

module.exports = mongoose.model('MatchingTodayMood', matchingTodayMoodSchema);
