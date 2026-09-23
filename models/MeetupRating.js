// models/MeetupRating.js
//
// A rating one Surprise Activity participant gives the other after the meetup.
//
// WHY THIS IS NOT models/Review.js
//
// Review exists and is the right shape conceptually, but it cannot hold these:
//
//   1. Review.bookingId is `unique: true` — one review per booking, TOTAL. A Surprise
//      Activity needs two: A rates B and B rates A. That alone rules it out.
//   2. Review.bookingId refs 'Booking', the paid companion model. getFlaggedReviews()
//      populates it, and a RandomBooking id would silently resolve to null there.
//   3. Review.canSubmitReview() requires booking.paymentStatus === 'paid' and reads
//      booking.userId / booking.companionId, none of which exist on RandomBooking.
//      Every Surprise Activity would be rejected by it.
//
// So the records live here, and the Review collection and /api/reviews routes are left
// completely untouched. What IS shared is the aggregate: Review.calculateRatingStats()
// reads both collections, so User.ratingStats stays the single trust surface and an
// admin hiding a Review can never wipe meetup ratings.

'use strict';
const mongoose = require('mongoose');

const meetupRatingSchema = new mongoose.Schema({
  // The Surprise Activity this rating is about.
  bookingId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'RandomBooking',
    required: true,
  },

  // Who is rating.
  reviewerId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },

  // Who is being rated — always the other participant.
  revieweeId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },

  rating: { type: Number, required: true, min: 1, max: 5 },

  // Optional free text. Same 300-char ceiling as Review.reviewText so the two
  // sources stay consistent if they are ever shown side by side.
  reviewText: { type: String, maxlength: 300, trim: true, default: null },

  // Moderation parity with Review, so a hidden rating can be excluded from the
  // aggregate the same way. Nothing writes these yet.
  isHiddenByAdmin:   { type: Boolean, default: false },
  adminHiddenReason: { type: String,  default: null  },

  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// One rating per participant per activity. This is the duplicate-submission guard,
// enforced by the database rather than by a read-then-write race in the route.
meetupRatingSchema.index({ bookingId: 1, reviewerId: 1 }, { unique: true });

// Aggregate lookup for a user's received ratings.
meetupRatingSchema.index({ revieweeId: 1, isHiddenByAdmin: 1, submittedAt: -1 });

module.exports = mongoose.model('MeetupRating', meetupRatingSchema);
