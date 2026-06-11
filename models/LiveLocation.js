// models/LiveLocation.js
const mongoose = require('mongoose');

const liveLocationSchema = new mongoose.Schema({
  sessionId: {
    type:     String,
    required: true,
    unique:   true,
    index:    true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },
  trustedContactName:  { type: String, default: '' },
  trustedContactPhone: { type: String, default: '' },

  // Latest coordinates — overwritten on every update (no history stored)
  lat:      { type: Number, default: null },
  lng:      { type: Number, default: null },
  accuracy: { type: Number, default: null },   // metres
  speed:    { type: Number, default: 0 },      // km/h

  movementType: {
    type:    String,
    enum:    ['Stationary', 'Walking', 'Running', 'Driving'],
    default: 'Stationary',
  },

  batteryLevel: { type: Number, default: null },  // 0–100

  // ── Emergency mode ─────────────────────────────────────────────────────────
  // When true: tracking page shows red emergency banner + urgent language
  // When false: standard safety sharing (default)
  isEmergency: { type: Boolean, default: false },

  isActive: { type: Boolean, default: true, index: true },

  startedAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },

  // Voluntary revocation timestamp (set when user manually stops sharing)
  revokedAt: { type: Date, default: null },

  // TTL index — MongoDB auto-deletes document 6 hours after expiresAt
  expiresAt: {
    type:    Date,
    default: () => new Date(Date.now() + 6 * 60 * 60 * 1000),
    index:   { expireAfterSeconds: 0 },
  },
}, { timestamps: false });

// ─── movement helper ────────────────────────────────────────────────────────
// Speed in km/h → movement label (updated thresholds per new spec)
// 0–2  = Stationary
// 2–7  = Walking
// 7–15 = Running
// 15+  = Driving
liveLocationSchema.statics.detectMovement = function (speedKmh) {
  if (!speedKmh || speedKmh < 2)  return 'Stationary';
  if (speedKmh < 7)               return 'Walking';
  if (speedKmh < 15)              return 'Running';
  return 'Driving';
};

module.exports = mongoose.model('LiveLocation', liveLocationSchema);
