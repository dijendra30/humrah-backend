// models/MatchingTodayMood.js
// Single collection — owns both live mood state AND nearby place cache per user.
// One document per user. Never deleted — TTL only clears expired mood visibility.
'use strict';
const mongoose = require('mongoose');

const nearbyDataSchema = new mongoose.Schema({
  count:  { type: Number, default: 0 },
  places: { type: [String], default: [] }, // top 2-3 place names
}, { _id: false });

const matchingTodayMoodSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  // Live mood state — written only on Go Live
  mood:         { type: String, default: null },
  vibeLevel:    { type: String, default: 'normal' }, // lowkey | normal | social
  intention:    { type: String, default: null },
  visible:      { type: Boolean, default: false },

  // Location + nearby cache — written only on app open
  locationHash: { type: String, default: null, index: true },
  nearbyData:   { type: nearbyDataSchema, default: () => ({ count: 0, places: [] }) },

  updatedAt:    { type: Date, default: Date.now },
  expiresAt:    { type: Date, default: null }, // null = mood not active; set to now+4h on Go Live
}, { collection: 'matchingtodaymoods' });

// Feed query: visible users with active mood
matchingTodayMoodSchema.index({ visible: 1, expiresAt: 1 });
matchingTodayMoodSchema.index({ locationHash: 1, visible: 1 });

module.exports = mongoose.model('MatchingTodayMood', matchingTodayMoodSchema);
