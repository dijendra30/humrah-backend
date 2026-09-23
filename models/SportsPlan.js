// models/SportsPlan.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 1A. A ONE-TIME local sports activity that several
// people can join.
//
// A NEW collection on purpose. Phase 0 established that nothing existing can hold
// this safely:
//   - MovieSession requires movie/theatre fields and a TTL deletes its documents.
//   - GamingSession's published feed filters on city + cardStatus but NOT gameType,
//     so a sports document stored there would appear in the live Gaming feed.
//   - RandomBooking is structurally 1-to-1 (a single scalar acceptorId).
//
// Conventions taken from the reference systems, and the ones deliberately NOT taken:
//   - Plan lifecycle (cardStatus/chatStatus split, kickedPlayers) follows Gaming.
//   - NO TTL index. Gaming removed its TTL because it deleted chat history; Sports
//     will need history for moderation and post-session ratings.
//   - NO stored player counter. The count is playersJoined.length. A separate
//     integer drifts; one array cannot.
//   - NO stored 'full' status. Gaming stores it; here it is derived, for the same
//     reason. Capacity is enforced by the join query itself, not by a flag.
//   - sportType and skillLevel are Strings validated in services/sportsPlanService.js,
//     NOT schema enums. A new sport must never need a schema deploy, and an existing
//     document must never fail validation because the allowed list changed.
//   - The creator's live/home location is NEVER stored here. `location` is the
//     VENUE's point, supplied explicitly by the client.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

/**
 * A public venue — a court, a ground, a gym.
 *
 * Deliberately the SAME shape as meetupPlaceSchema in models/Meetup.js, so the app
 * has one venue format rather than two. That schema is not exported, and exporting
 * it would mean editing Meetup.js, so the shape is mirrored here field for field.
 *
 * latitude/longitude are the VENUE's published coordinates — never a person's.
 * They equal location.coordinates (written together from one validated input, and
 * plans are not editable in Phase 1A, so the two cannot drift).
 */
const sportsVenueSchema = new mongoose.Schema({
  provider:        { type: String, enum: ['GOOGLE_PLACES', 'MANUAL'], default: null },
  providerPlaceId: { type: String, default: null },
  name:            { type: String, default: null, trim: true },
  latitude:        { type: Number, default: null },
  longitude:       { type: Number, default: null },
  photoReference:  { type: String, default: null },
  rating:          { type: Number, default: null },
  address:         { type: String, default: null, trim: true },
  openingStatus:   { type: String, default: null },
}, { _id: false });

const sportsPlanSchema = new mongoose.Schema({
  // Always the authenticated caller. Never taken from the request body.
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Route-validated against SPORT_TYPES in the service. Not an enum — see header.
  sportType: { type: String, required: true, trim: true },

  // Reserved. The API does not accept a custom sport in Phase 1A because the
  // product has no "Other" option yet; the field exists so adding one later is
  // not a schema change.
  customSportName: { type: String, default: null, trim: true, maxlength: 30 },

  // The Date fields are the only source of truth for timing. No parallel
  // 'date'/'time' strings, unlike MovieSession.
  startTime: { type: Date, required: true },
  endTime:   { type: Date, required: true },

  venue: { type: sportsVenueSchema, required: true },

  // GeoJSON Point [lng, lat] of the VENUE. Authoritative for nearby discovery.
  location: {
    type:        { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },
  },

  // Lower-cased and trimmed, like MovieSession.city. A secondary label only —
  // discovery is by geo distance, never by city string.
  city: { type: String, default: '', trim: true },

  // Total players INCLUDING the creator. The upper bound is enforced in the
  // service (a temporary Phase 1A limit) rather than here, so raising or
  // lowering it never makes an existing document fail validation.
  playerLimit: { type: Number, required: true, min: 2 },

  // The ONE source of truth for membership. The creator is always element 0.
  // (Movie keeps membership in two places — an array and a collection — which
  // can disagree. Deliberately not repeated.)
  playersJoined: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Route-validated against SKILL_LEVELS in the service. Not an enum.
  skillLevel: { type: String, required: true, trim: true },

  // 120 characters: the same limit as GamingSession.optionalMessage, the closest
  // existing equivalent of a plan note.
  note: { type: String, default: null, trim: true, maxlength: 120 },

  // Feed card lifecycle. 'expired' is reserved for a later sweep; in Phase 1A a
  // plan whose start time has passed is treated as expired at read time instead.
  cardStatus: {
    type: String,
    enum: ['open', 'cancelled', 'expired'],
    default: 'open',
    required: true,
  },

  // Chat lifecycle, independent of the card — the Gaming split. No chat exists
  // yet; this is set now so Phase 4 has a controlled lifetime to work with.
  chatStatus: {
    type: String,
    enum: ['open', 'closed'],
    default: 'open',
    required: true,
  },
  chatExpiresAt: { type: Date, required: true },

  // Removed players who may not rejoin. Written by a later host-controls phase;
  // the join query already refuses anyone listed here.
  kickedPlayers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  cancelledAt: { type: Date, default: null },
}, { timestamps: true });

// ── Indexes — only what a Phase 1A query actually uses ─────────────────────────
// Nearby discovery ($geoNear).
sportsPlanSchema.index({ location: '2dsphere' });
// Open, upcoming plans (the $geoNear query filter).
sportsPlanSchema.index({ cardStatus: 1, startTime: 1 });
// Chat expiry — for the Phase 4 sweep.
sportsPlanSchema.index({ chatStatus: 1, chatExpiresAt: 1 });
// "Does this creator already have an active plan?" on create.
sportsPlanSchema.index({ creatorId: 1, createdAt: -1 });
// NO TTL INDEX. Documents are kept; visibility is controlled by the status fields.

module.exports = mongoose.model('SportsPlan', sportsPlanSchema);
