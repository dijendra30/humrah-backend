// models/MovieSession.js
const mongoose = require('mongoose');

const movieSessionSchema = new mongoose.Schema({
  movieId:        { type: String, required: true },
  movieTitle:     { type: String, required: true },
  poster:         { type: String, default: null },
  language:       { type: String, default: 'Hindi' }, // from user.questionnaire.languagePreference

  theatreName:    { type: String, required: true },
  theatreAddress: { type: String, required: true },
  theatrePlaceId: { type: String, default: null },

  // GeoJSON Point — [lng, lat] (MongoDB standard)
  theatreLocation: {
    type:        { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }
  },

  date:     { type: String, required: true }, // "YYYY-MM-DD"
  time:     { type: String, required: true }, // "HH:mm"
  showTime: { type: Date,   required: true }, // full datetime

  expiresAt:     { type: Date, required: true }, // showTime + 15 min  (card disappears)
  chatExpiresAt: { type: Date, required: true }, // showTime + 3 hrs   (chat stays)

  // 'system' string OR ObjectId
  createdBy:    { type: mongoose.Schema.Types.Mixed, ref: 'User', required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Display-only simulated count for system sessions (no fake user IDs)
  simulatedParticipants: { type: Number, default: 0 },

  maxParticipants:  { type: Number, default: 4, min: 2, max: 5 },
  isBoosted:        { type: Boolean, default: false },  // urgent / boosted
  isSystemGenerated:{ type: Boolean, default: false },
  status:           { type: String, enum: ['active', 'expired'], default: 'active' },

  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'MovieChat', default: null }
}, { timestamps: true });

// ── Indexes ────────────────────────────────────────────────────────────────────
movieSessionSchema.index({ theatreLocation: '2dsphere' });
movieSessionSchema.index({ status: 1, expiresAt: 1 });
movieSessionSchema.index({ language: 1, status: 1 });

// TTL index — MongoDB auto-deletes documents 1 day after expiry (keeps DB clean)
movieSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('MovieSession', movieSessionSchema);
