// models/MovieSession.js
// ─────────────────────────────────────────────────────────────────────────────
// FIELD NOTES:
//  • location       — GeoJSON Point [lng, lat]. Field named 'location' per spec.
//                     BREAKING CHANGE from old 'theatreLocation' — old documents
//                     will not appear in geo queries (they expire naturally).
//  • adminId        — first real user to join a system session (assigned atomically)
//  • participants   — REAL user ObjectIds only. NEVER fake/simulated.
//  • simulatedParticipants — REMOVED. We NEVER show fake social proof.
//  • createdBy      — 'system' string for auto-generated, ObjectId for user sessions
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require('mongoose');

const movieSessionSchema = new mongoose.Schema({
  movieId:        { type: String, required: true },
  movieTitle:     { type: String, required: true },
  poster:         { type: String, default: null },
  // Language comes from user.questionnaire.languagePreference — NEVER from frontend
  language:       { type: String, default: 'Hindi' },

  theatreName:    { type: String, required: true },
  theatreAddress: { type: String, required: true },
  theatrePlaceId: { type: String, default: null },

  // GeoJSON Point — stored as [lng, lat] per MongoDB spec
  location: {
    type:        { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },   // [lng, lat]
  },

  date:     { type: String, required: true },  // 'YYYY-MM-DD'
  time:     { type: String, required: true },  // 'HH:mm'
  showTime: { type: Date,   required: true },

  // Session card disappears 15 min after showTime
  expiresAt:     { type: Date, required: true },
  // Chat remains 3 hrs after showTime
  chatExpiresAt: { type: Date, required: true },

  // 'system' (string) for auto-generated, ObjectId for user-created
  createdBy:    { type: mongoose.Schema.Types.Mixed, default: 'system' },

  // Real users only — NEVER simulated IDs
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  maxParticipants: { type: Number, default: 4, min: 2, max: 5 },

  // First real user to join a system session (assigned atomically)
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  isBoosted:         { type: Boolean, default: false },
  isSystemGenerated: { type: Boolean, default: false },
  status:            { type: String, enum: ['active', 'expired'], default: 'active' },

  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'MovieChat', default: null },

  // Notification sent flag — avoids duplicate post-session notifications
  postSessionNotified: { type: Boolean, default: false },

}, { timestamps: true });

// ── Indexes ────────────────────────────────────────────────────────────────────
movieSessionSchema.index({ location: '2dsphere' });
movieSessionSchema.index({ status: 1, expiresAt: 1 });
movieSessionSchema.index({ language: 1, status: 1 });
movieSessionSchema.index({ createdBy: 1, status: 1 });

// MongoDB TTL — auto-delete expired docs after 24 hrs (keeps collection clean)
movieSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('MovieSession', movieSessionSchema);
