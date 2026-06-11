// models/RandomBooking.js
'use strict';
const mongoose = require('mongoose');

const candidateEntrySchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  score:       { type: Number, required: true },
  distance:    { type: Number, required: true },        // km
  stage:       { type: Number, default: 1 },            // 1 | 2 | 3 escalation stage
  sentAt:      { type: Date, default: null },
  response:    { type: String, enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'TIMED_OUT', 'REVIEWING'], default: 'PENDING' },
  respondedAt: { type: Date, default: null }
}, { _id: false });

const randomBookingSchema = new mongoose.Schema({
  initiatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  acceptorId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  city: { type: String, required: true },
  lat:  { type: Number, required: true, min: -90,  max: 90  },
  lng:  { type: Number, required: true, min: -180, max: 180 },

  // ── Frozen match-search location ────────────────────────────────────────────
  // Captured at booking creation time from the user's liveLocation.
  // Used for all candidate matching/search so that the initiator moving later
  // does NOT affect an active meetup request's search area.
  // This is the single source of truth for "where was the user when they posted".
  matchSearchLocation: {
    lat:         { type: Number, default: null },
    lng:         { type: Number, default: null },
    city:        { type: String, default: null },
    state:       { type: String, default: null },
    capturedAt:  { type: Date,   default: null },
  },

  locationCategory: {
    type: String,
    enum: ['Park', 'Mall', 'Cafe', 'Event Venue', 'Public Place'],
    default: 'Public Place'
  },
  activityType: {
    type: String,
    enum: ['WALK', 'FOOD', 'EVENT', 'EXPLORE', 'CASUAL'],
    required: true
  },

  meetupEnergy: {
    type: [String],
    enum: ['QUIET', 'CHILL', 'DEEP_TALK', 'FUN', 'STUDY_BUDDY', 'CREATIVE_VIBES', 'SOCIAL_RECHARGE', 'LOW_ENERGY'],
    default: []
  },
  blurProfileUntilAccepted: { type: Boolean, default: false },

  // ── Matchmaking mode ───────────────────────────────────────────────────────
  // STANDARD — meetup planned > 30 min ahead; deep compatibility, slower cadence
  // FAST     — meetup < 30 min away; prioritize online/nearby, shorter reserve window
  matchMode: { type: String, enum: ['STANDARD', 'FAST'], default: 'STANDARD' },

  // current escalation stage (1 = strict, 2 = wider radius, 3 = broadest)
  matchStage: { type: Number, default: 1, min: 1, max: 3 },

  candidateQueue:        { type: [candidateEntrySchema], default: [] },
  currentCandidateIndex: { type: Number, default: -1 },
  reservedUntil:         { type: Date, default: null },

  // set when a candidate taps "Review Meetup" — holds the booking for them briefly
  reviewingUntil:  { type: Date, default: null },
  reviewingUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  startTime: { type: Date, required: true },
  endTime:   { type: Date, required: true },

  status: {
    type: String,
    enum: ['PENDING', 'SEARCHING', 'RESERVED', 'REVIEWING', 'MATCHED', 'CANCELLED', 'COMPLETED', 'EXPIRED'],
    default: 'PENDING',
    required: true
  },

  createdAt:          { type: Date, default: Date.now, required: true, index: true },
  matchedAt:          { type: Date, default: null },
  cancelledAt:        { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  completedAt:        { type: Date, default: null },
  expiredAt:          { type: Date, default: null },
  expiresAt:          { type: Date, required: true },

  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'RandomBookingChat', default: null }
}, { timestamps: true });

// ── Indexes ────────────────────────────────────────────────────────────────────
randomBookingSchema.index({ lat: 1, lng: 1 });
randomBookingSchema.index({ 'matchSearchLocation.lat': 1, 'matchSearchLocation.lng': 1 });
randomBookingSchema.index({ city: 1, status: 1, expiresAt: 1 });
randomBookingSchema.index({ status: 1, startTime: 1 });
randomBookingSchema.index({ status: 1, reservedUntil: 1 });
randomBookingSchema.index({ status: 1, reviewingUntil: 1 });

// ── Instance helpers ───────────────────────────────────────────────────────────
randomBookingSchema.methods.isExpired = function () {
  return this.expiresAt < new Date() || this.status === 'EXPIRED';
};
randomBookingSchema.methods.cancel = function (reason) {
  this.status = 'CANCELLED'; this.cancelledAt = new Date(); this.cancellationReason = reason || 'User cancelled';
  return this.save();
};
randomBookingSchema.methods.complete = function () {
  this.status = 'COMPLETED'; this.completedAt = new Date(); return this.save();
};
randomBookingSchema.methods.getCurrentCandidate = function () {
  if (this.currentCandidateIndex < 0 || this.currentCandidateIndex >= this.candidateQueue.length) return null;
  return this.candidateQueue[this.currentCandidateIndex];
};

// Advance queue pointer; window varies by matchMode
randomBookingSchema.methods.advanceToNextCandidate = function () {
  const next = this.currentCandidateIndex + 1;
  if (next >= this.candidateQueue.length) return null;
  this.currentCandidateIndex = next;
  const windowSec = this.matchMode === 'FAST' ? 45 : 90;   // 45s fast, 90s standard
  this.reservedUntil = new Date(Date.now() + windowSec * 1000);
  this.status = 'RESERVED';
  this.candidateQueue[next].sentAt = new Date();
  return this.candidateQueue[next];
};

/**
 * Returns the effective lat/lng to use for matchmaking searches.
 * Prefers the frozen matchSearchLocation (set at creation) so that
 * the initiator moving later doesn't shift an active search radius.
 * Falls back to the booking's own lat/lng.
 */
randomBookingSchema.methods.getMatchingCoords = function () {
  const msl = this.matchSearchLocation;
  if (msl && msl.lat != null && msl.lng != null) {
    return { lat: msl.lat, lng: msl.lng };
  }
  return { lat: this.lat, lng: this.lng };
};

// ── Statics ────────────────────────────────────────────────────────────────────
randomBookingSchema.statics.cleanupExpired = async function () {
  const now = new Date();
  // RESERVED/REVIEWING bookings: only expire if booking's startTime has passed
  // (not just expiresAt) — prevents killing active candidate windows mid-review.
  // PENDING/SEARCHING: expire normally when expiresAt passes.
  return this.updateMany(
    {
      $or: [
        // Safe to expire: no active candidate window
        { status: { $in: ['PENDING', 'SEARCHING'] }, expiresAt: { $lt: now } },
        // Only expire RESERVED/REVIEWING if startTime itself has passed
        { status: { $in: ['RESERVED', 'REVIEWING'] }, startTime: { $lt: now } },
      ]
    },
    { status: 'EXPIRED', expiredAt: now }
  );
};

module.exports = mongoose.model('RandomBooking', randomBookingSchema);
