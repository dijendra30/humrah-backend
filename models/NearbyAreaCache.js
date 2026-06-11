// models/NearbyAreaCache.js
// Shared area-level cache for nearby places.
// ONE document per locationHash (2-decimal lat_lng grid).
// ALL users in same area share this — no duplication.
'use strict';
const mongoose = require('mongoose');

const moodDataSchema = new mongoose.Schema({
  count:  { type: Number, default: 0 },
  places: { type: [String], default: [] },
}, { _id: false });

const nearbyAreaCacheSchema = new mongoose.Schema({
  locationHash: { type: String, required: true, unique: true, index: true },

  moods: {
    cafe:    { type: moodDataSchema, default: () => ({ count: 0, places: [] }) },
    food:    { type: moodDataSchema, default: () => ({ count: 0, places: [] }) },
    walk:    { type: moodDataSchema, default: () => ({ count: 0, places: [] }) },
    study:   { type: moodDataSchema, default: () => ({ count: 0, places: [] }) },
    fitness: { type: moodDataSchema, default: () => ({ count: 0, places: [] }) },
    explore: { type: moodDataSchema, default: () => ({ count: 0, places: [] }) },
  },

  globalPlaces: { type: [String], default: [] }, // fallback list

  generatedAt: { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
  expiresAt:   { type: Date, required: true, index: true },
}, {
  collection: 'nearbyareacaches',
  timestamps: false,
});

module.exports = mongoose.model('NearbyAreaCache', nearbyAreaCacheSchema);
