// models/Review.js - Rating and Review Model
const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  // Link to booking - ensures one review per booking
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true,
    unique: true,
    // ✅ FIX: removed index:true — unique:true already creates an index automatically.
    // The explicit reviewSchema.index({ bookingId:1 }, { unique:true }) below was also
    // redundant, so it has been removed too. One unique:true is all that is needed.
  },

  // Reviewer (person giving rating)
  reviewerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: removed index:true — covered by compound index({ revieweeId, ... }) below
  },

  // Reviewee (person receiving rating)
  revieweeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: removed index:true — covered by compound index({ revieweeId, ... }) below
  },

  // Rating (1-5 stars)
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },

  // Optional written review
  reviewText: {
    type: String,
    maxlength: 300,
    trim: true,
    default: null
  },

  // Visibility controls
  isHiddenByReviewee: {
    type: Boolean,
    default: false
  },

  // Admin moderation
  isFlaggedForReview: {
    type: Boolean,
    default: false,
    // ✅ FIX: removed index:true — covered by compound index({ isFlaggedForReview, submittedAt }) below
  },

  flagReason: {
    type: String,
    enum: ['duplicate_ip', 'new_reviewer', 'batch_reviews', 'user_report', null],
    default: null
  },

  isHiddenByAdmin:    { type: Boolean, default: false },
  adminHiddenReason:  { type: String,  default: null  },

  hiddenByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  hiddenByAdminAt: { type: Date, default: null },

  // Metadata
  submittedAt: {
    type: Date,
    default: Date.now,
    // ✅ FIX: removed index:true — covered by compound indexes below
  },

  ipAddress: { type: String, required: true },
  userAgent:  { type: String, default: null  }

}, {
  timestamps: true
});

// =============================================
// INDEXES — single source of truth, no duplicates
// =============================================
// Fast lookup for user's reviews
reviewSchema.index({ revieweeId: 1, isHiddenByReviewee: 1, isHiddenByAdmin: 1, submittedAt: -1 });
// Admin moderation queries
reviewSchema.index({ isFlaggedForReview: 1, submittedAt: -1 });
// ✅ FIX: removed the explicit reviewSchema.index({ bookingId:1 }, { unique:true }) that
// was here before — unique:true on the field definition above already handles this.

// =============================================
// VIRTUAL PROPERTIES
// =============================================
reviewSchema.virtual('isVisible').get(function() {
  return !this.isHiddenByReviewee && !this.isHiddenByAdmin;
});

// =============================================
// STATIC METHODS
// =============================================

reviewSchema.statics.getPublicReviews = async function(userId, options = {}) {
  const { page = 1, limit = 10, sort = 'recent' } = options;

  const query = {
    revieweeId: userId,
    isHiddenByReviewee: false,
    isHiddenByAdmin: false
  };

  const sortOptions = sort === 'rating'
    ? { rating: -1, submittedAt: -1 }
    : { submittedAt: -1 };

  const reviews = await this.find(query)
    .populate('reviewerId', 'firstName lastName profilePhoto')
    .sort(sortOptions)
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const total = await this.countDocuments(query);

  return {
    reviews: reviews.map(review => ({
      ...review,
      reviewerName: review.reviewerId?.firstName
        ? `${review.reviewerId.firstName} ${review.reviewerId.lastName.charAt(0)}.`
        : 'Deleted User',
      reviewerPhoto: review.reviewerId?.profilePhoto || null
    })),
    pagination: { page, limit, totalReviews: total, totalPages: Math.ceil(total / limit) }
  };
};

reviewSchema.statics.calculateRatingStats = async function(userId) {
  const reviews = await this.find({
    revieweeId: userId,
    isHiddenByReviewee: false,
    isHiddenByAdmin: false
  }).select('rating').lean();

  if (reviews.length === 0) {
    return {
      averageRating: 0,
      totalRatings: 0,
      starDistribution: { five: 0, four: 0, three: 0, two: 0, one: 0 }
    };
  }

  const starDistribution = {
    five:  reviews.filter(r => r.rating === 5).length,
    four:  reviews.filter(r => r.rating === 4).length,
    three: reviews.filter(r => r.rating === 3).length,
    two:   reviews.filter(r => r.rating === 2).length,
    one:   reviews.filter(r => r.rating === 1).length
  };

  const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
  const averageRating = Math.round((totalRating / reviews.length) * 10) / 10;

  return { averageRating, totalRatings: reviews.length, starDistribution };
};

reviewSchema.statics.canSubmitReview = async function(bookingId, userId) {
  const Booking = mongoose.model('Booking');

  const existingReview = await this.findOne({ bookingId });
  if (existingReview) {
    return { canSubmit: false, reason: 'Review already submitted for this booking' };
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) return { canSubmit: false, reason: 'Booking not found' };

  if (booking.userId.toString() !== userId && booking.companionId.toString() !== userId) {
    return { canSubmit: false, reason: 'You are not part of this booking' };
  }

  if (booking.status !== 'completed') return { canSubmit: false, reason: 'Booking must be completed' };
  if (booking.paymentStatus !== 'paid') return { canSubmit: false, reason: 'Booking must be paid' };

  const daysSinceCompletion = (Date.now() - booking.updatedAt) / (1000 * 60 * 60 * 24);
  if (daysSinceCompletion > 7) {
    return { canSubmit: false, reason: 'Review window expired (7 days after completion)' };
  }

  return { canSubmit: true };
};

reviewSchema.statics.checkForFraud = async function(reviewData) {
  const flags = [];

  const User = mongoose.model('User');
  const reviewee = await User.findById(reviewData.revieweeId).select('lastLoginIp');
  if (reviewee && reviewee.lastLoginIp === reviewData.ipAddress) {
    flags.push({ type: 'duplicate_ip', severity: 'high', message: 'Reviewer and reviewee share same IP address' });
  }

  const Booking = mongoose.model('Booking');
  const reviewerBookings = await Booking.countDocuments({
    $or: [{ userId: reviewData.reviewerId }, { companionId: reviewData.reviewerId }],
    status: 'completed',
    paymentStatus: 'paid'
  });
  if (reviewerBookings < 2) {
    flags.push({ type: 'new_reviewer', severity: 'medium', message: 'Reviewer has less than 2 completed bookings' });
  }

  if (reviewData.rating === 5) {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recentFiveStars = await this.countDocuments({
      revieweeId: reviewData.revieweeId,
      rating: 5,
      submittedAt: { $gte: twoDaysAgo }
    });
    if (recentFiveStars >= 10) {
      flags.push({ type: 'batch_reviews', severity: 'high', message: 'User received more than 10 5-star reviews in 48 hours' });
    }
  }

  return flags;
};

reviewSchema.statics.getFlaggedReviews = async function(options = {}) {
  const { page = 1, limit = 20 } = options;

  const reviews = await this.find({ isFlaggedForReview: true, isHiddenByAdmin: false })
    .populate('reviewerId revieweeId', 'firstName lastName email profilePhoto')
    .populate('bookingId')
    .sort({ submittedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const total = await this.countDocuments({ isFlaggedForReview: true, isHiddenByAdmin: false });

  return {
    reviews,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
};

// =============================================
// INSTANCE METHODS
// =============================================

reviewSchema.methods.hideByAdmin = async function(adminId, reason) {
  this.isHiddenByAdmin    = true;
  this.adminHiddenReason  = reason;
  this.hiddenByAdminId    = adminId;
  this.hiddenByAdminAt    = new Date();
  await this.save();

  const User = mongoose.model('User');
  const stats = await this.constructor.calculateRatingStats(this.revieweeId);
  await User.findByIdAndUpdate(this.revieweeId, { ratingStats: stats });
  return this;
};

reviewSchema.methods.unhideByAdmin = async function() {
  this.isHiddenByAdmin   = false;
  this.adminHiddenReason = null;
  this.hiddenByAdminId   = null;
  this.hiddenByAdminAt   = null;
  await this.save();

  const User = mongoose.model('User');
  const stats = await this.constructor.calculateRatingStats(this.revieweeId);
  await User.findByIdAndUpdate(this.revieweeId, { ratingStats: stats });
  return this;
};

module.exports = mongoose.model('Review', reviewSchema);
