// models/Booking.js - UPDATED Booking Schema with Payment Tracking
const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  // Participants
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  companionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Booking Details
  bookingDate: {
    type: Date,
    required: true
  },
  
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'completed'],
    default: 'pending',
    index: true
  },
  
  meetingLocation: String,
  notes: String,
  
  // =============================================
  // PAYMENT TRACKING (NEW)
  // =============================================
  
  // Pricing
  totalAmount: {
    type: Number,
    required: true,
    min: 0
  },
  
  platformFee: {
    type: Number,
    default: 0,
    min: 0
  },
  
  companionEarning: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Payment Status
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'refunded', 'failed'],
    default: 'pending',
    index: true
  },
  
  paymentId: {
    type: String,
    default: null
  },
  
  paidAt: {
    type: Date,
    default: null
  },
  
  // Payout Tracking
  earningsPaidOut: {
    type: Boolean,
    default: false,
    index: true
  },
  
  payoutId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payout',
    default: null
  },
  
  payoutDate: {
    type: Date,
    default: null
  },
  
  // =============================================
  // REVIEW TRACKING (NEW)
  // =============================================
  
  reviewSubmitted: {
    type: Boolean,
    default: false
  },
  
  reviewId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Review',
    default: null
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { 
  timestamps: true 
});

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
bookingSchema.index({ userId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ companionId: 1, status: 1, paymentStatus: 1 });
bookingSchema.index({ status: 1, paymentStatus: 1, earningsPaidOut: 1 });

// =============================================
// PRE-SAVE HOOKS
// =============================================

/**
 * Calculate platform fee and companion earning before save
 */
bookingSchema.pre('save', function(next) {
  if (this.isModified('totalAmount')) {
    this.platformFee = Math.round(this.totalAmount * 0.25);
    this.companionEarning = Math.round(this.totalAmount * 0.75);
  }
  next();
});

/**
 * Update companion earnings when booking is completed
 */
bookingSchema.post('save', async function(doc, next) {
  // Check if status just changed to 'completed' and payment is 'paid'
  if (doc.status === 'completed' && 
      doc.paymentStatus === 'paid' && 
      !doc.earningsPaidOut) {
    
    const { updateEarningsOnBookingCompletion } = require('../jobs/payoutCron');
    await updateEarningsOnBookingCompletion(doc._id);
  }
  
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================

/**
 * Mark booking as paid
 */
bookingSchema.methods.markAsPaid = async function(paymentId) {
  this.paymentStatus = 'paid';
  this.paymentId = paymentId;
  this.paidAt = new Date();
  
  await this.save();
  return this;
};

/**
 * Mark booking as completed
 */
bookingSchema.methods.complete = async function() {
  if (this.status !== 'confirmed') {
    throw new Error('Only confirmed bookings can be completed');
  }
  
  if (this.paymentStatus !== 'paid') {
    throw new Error('Payment must be completed before marking as complete');
  }
  
  this.status = 'completed';
  await this.save();
  
  return this;
};

/**
 * Cancel booking with refund
 */
bookingSchema.methods.cancel = async function(reason) {
  if (this.status === 'completed') {
    throw new Error('Cannot cancel completed booking');
  }
  
  this.status = 'cancelled';
  
  // If payment was made, mark for refund
  if (this.paymentStatus === 'paid') {
    this.paymentStatus = 'refunded';
    
    // Process refund via payment gateway
    const paymentGateway = require('../services/paymentGateway');
    await paymentGateway.refundPayment(this.paymentId, this.totalAmount);
  }
  
  await this.save();
  return this;
};

/**
 * Check if booking is eligible for review
 */
bookingSchema.methods.isEligibleForReview = function() {
  if (this.status !== 'completed') return false;
  if (this.paymentStatus !== 'paid') return false;
  if (this.reviewSubmitted) return false;
  
  // Check 7-day window
  const daysSinceCompletion = (Date.now() - this.updatedAt) / (1000 * 60 * 60 * 24);
  if (daysSinceCompletion > 7) return false;
  
  return true;
};

// =============================================
// STATIC METHODS
// =============================================

/**
 * Get bookings for user (as booker or companion)
 */
bookingSchema.statics.getUserBookings = async function(userId, options = {}) {
  const {
    role = 'all', // 'booker', 'companion', 'all'
    status = null,
    page = 1,
    limit = 10
  } = options;
  
  const query = {};
  
  if (role === 'booker') {
    query.userId = userId;
  } else if (role === 'companion') {
    query.companionId = userId;
  } else {
    query.$or = [{ userId }, { companionId }];
  }
  
  if (status) {
    query.status = status;
  }
  
  const bookings = await this.find(query)
    .populate('userId companionId', 'firstName lastName profilePhoto')
    .sort({ bookingDate: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  
  const total = await this.countDocuments(query);
  
  return {
    bookings,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
};

/**
 * Get completed bookings count for user (as companion)
 */
bookingSchema.statics.getCompletedBookingsCount = async function(companionId) {
  return this.countDocuments({
    companionId,
    status: 'completed',
    paymentStatus: 'paid'
  });
};

/**
 * Get unpaid earnings for companion
 */
bookingSchema.statics.getUnpaidEarnings = async function(companionId) {
  const bookings = await this.find({
    companionId,
    status: 'completed',
    paymentStatus: 'paid',
    earningsPaidOut: false
  }).select('companionEarning').lean();
  
  const total = bookings.reduce((sum, b) => sum + b.companionEarning, 0);
  
  return {
    totalAmount: total,
    bookingCount: bookings.length,
    bookingIds: bookings.map(b => b._id)
  };
};

module.exports = mongoose.model('Booking', bookingSchema);
