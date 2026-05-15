// routes/reviews.js - Rating and Review Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Review = require('../models/Review');
const Booking = require('../models/Booking');
const User = require('../models/User');

// @route   POST /api/reviews/booking/:bookingId
// @desc    Submit a review for a completed booking
// @access  Private
router.post('/booking/:bookingId', auth, async (req, res) => {
  try {
    const { rating, reviewText } = req.body;
    const bookingId = req.params.bookingId;
    
    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }
    
    // Validate review text length
    if (reviewText && reviewText.length > 300) {
      return res.status(400).json({
        success: false,
        message: 'Review text must be 300 characters or less'
      });
    }
    
    // Check if review can be submitted
    const eligibility = await Review.canSubmitReview(bookingId, req.userId);
    if (!eligibility.canSubmit) {
      return res.status(400).json({
        success: false,
        message: eligibility.reason
      });
    }
    
    // Get booking to determine reviewee
    const booking = await Booking.findById(bookingId);
    const revieweeId = booking.userId.toString() === req.userId
      ? booking.companionId
      : booking.userId;
    
    // Create review
    const review = await Review.create({
      bookingId,
      reviewerId: req.userId,
      revieweeId,
      rating,
      reviewText: reviewText || null,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });
    
    // Check for fraud patterns
    const fraudFlags = await Review.checkForFraud({
      reviewerId: req.userId,
      revieweeId,
      rating,
      ipAddress: req.ip
    });
    
    if (fraudFlags.length > 0) {
      review.isFlaggedForReview = true;
      review.flagReason = fraudFlags[0].type;
      await review.save();
    }
    
    // Update reviewee's rating stats
    const reviewee = await User.findById(revieweeId);
    await reviewee.updateRatingStats();
    
    // Mark booking as reviewed
    booking.reviewSubmitted = true;
    booking.reviewId = review._id;
    await booking.save();
    
    // Populate reviewer info for response
    await review.populate('reviewerId', 'firstName lastName profilePhoto');
    
    res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      review: {
        reviewId: review._id,
        rating: review.rating,
        reviewText: review.reviewText,
        submittedAt: review.submittedAt,
        isFlagged: review.isFlaggedForReview
      },
      updatedRating: {
        average: reviewee.ratingStats.averageRating,
        totalRatings: reviewee.ratingStats.totalRatings
      }
    });
    
  } catch (error) {
    console.error('Submit review error:', error);
    
    // Handle duplicate review error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Review already submitted for this booking'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/reviews/user/:userId
// @desc    Get all reviews for a user
// @access  Private
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10, sort = 'recent' } = req.query;
    
    const result = await Review.getPublicReviews(req.params.userId, {
      page: parseInt(page),
      limit: parseInt(limit),
      sort
    });
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/reviews/:reviewId/hide
// @desc    Hide a review (user can hide reviews on their profile)
// @access  Private
router.put('/:reviewId/hide', auth, async (req, res) => {
  try {
    const review = await Review.findById(req.params.reviewId);
    
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }
    
    // Only reviewee can hide their own reviews
    if (review.revieweeId.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only hide reviews on your own profile'
      });
    }
    
    review.isHiddenByReviewee = true;
    await review.save();
    
    // Update rating stats (recalculate without hidden reviews)
    const user = await User.findById(req.userId);
    await user.updateRatingStats();
    
    res.json({
      success: true,
      message: 'Review hidden successfully'
    });
    
  } catch (error) {
    console.error('Hide review error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/reviews/:reviewId/unhide
// @desc    Unhide a previously hidden review
// @access  Private
router.put('/:reviewId/unhide', auth, async (req, res) => {
  try {
    const review = await Review.findById(req.params.reviewId);
    
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }
    
    if (review.revieweeId.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    review.isHiddenByReviewee = false;
    await review.save();
    
    // Update rating stats
    const user = await User.findById(req.userId);
    await user.updateRatingStats();
    
    res.json({
      success: true,
      message: 'Review unhidden successfully'
    });
    
  } catch (error) {
    console.error('Unhide review error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/reviews/:reviewId/report
// @desc    Report a review as fake or abusive
// @access  Private
router.post('/:reviewId/report', auth, async (req, res) => {
  try {
    const { reason, description } = req.body;
    
    const review = await Review.findById(req.params.reviewId);
    
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }
    
    // Create a safety report
    const SafetyReport = require('../models/SafetyReport');
    const report = await SafetyReport.create({
      reporterId: req.userId,
      reportedItemType: 'review',
      reportedItemId: review._id,
      reportedUserId: review.reviewerId,
      category: 'FAKE_REVIEW',
      reason,
      description: description || null,
      priority: 'MEDIUM',
      status: 'PENDING'
    });
    
    // Flag the review
    review.isFlaggedForReview = true;
    review.flagReason = 'user_report';
    await review.save();
    
    res.json({
      success: true,
      message: 'Review reported successfully. Our team will review it within 24 hours.',
      reportId: report._id
    });
    
  } catch (error) {
    console.error('Report review error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/reviews/stats/:userId
// @desc    Get rating statistics for a user
// @access  Private
router.get('/stats/:userId', auth, async (req, res) => {
  try {
    const stats = await Review.calculateRatingStats(req.params.userId);
    
    res.json({
      success: true,
      stats
    });
    
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// ADMIN ROUTES
// =============================================

// @route   GET /api/reviews/admin/flagged
// @desc    Get flagged reviews for admin review
// @access  Private (Admin only)
router.get('/admin/flagged', auth, async (req, res) => {
  try {
    // Check admin permission
    if (req.user.role !== 'SAFETY_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }
    
    const { page = 1, limit = 20 } = req.query;
    
    const result = await Review.getFlaggedReviews({
      page: parseInt(page),
      limit: parseInt(limit)
    });
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    console.error('Get flagged reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/reviews/admin/:reviewId/hide
// @desc    Hide review (admin action)
// @access  Private (Admin only)
router.put('/admin/:reviewId/hide', auth, async (req, res) => {
  try {
    // Check admin permission
    if (req.user.role !== 'SAFETY_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }
    
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Reason is required'
      });
    }
    
    const review = await Review.findById(req.params.reviewId);
    
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }
    
    await review.hideByAdmin(req.userId, reason);
    
    res.json({
      success: true,
      message: 'Review hidden by admin'
    });
    
  } catch (error) {
    console.error('Admin hide review error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/reviews/admin/:reviewId/unhide
// @desc    Unhide review (admin action)
// @access  Private (Admin only)
router.put('/admin/:reviewId/unhide', auth, async (req, res) => {
  try {
    // Check admin permission
    if (req.user.role !== 'SAFETY_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }
    
    const review = await Review.findById(req.params.reviewId);
    
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }
    
    await review.unhideByAdmin();
    
    res.json({
      success: true,
      message: 'Review unhidden by admin'
    });
    
  } catch (error) {
    console.error('Admin unhide review error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
