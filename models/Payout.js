// models/Payout.js - Payout Transaction Model
const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  // User receiving payout
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Payout amount
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  
  // UPI details at time of payout
  upiId: {
    type: String,
    required: true
  },
  
  upiName: {
    type: String,
    required: true
  },
  
  // Payout status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
    index: true
  },
  
  // Payment gateway details
  transactionId: {
    type: String,
    default: null,
    index: true
  },
  
  gatewayResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // Bookings included in this payout
  bookingsIncluded: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  }],
  
  // Timestamps
  initiatedAt: {
    type: Date,
    default: Date.now
  },
  
  processingStartedAt: {
    type: Date,
    default: null
  },
  
  completedAt: {
    type: Date,
    default: null
  },
  
  // Failure handling
  failureReason: {
    type: String,
    default: null
  },
  
  retryCount: {
    type: Number,
    default: 0
  },
  
  lastRetryAt: {
    type: Date,
    default: null
  },
  
  nextRetryAt: {
    type: Date,
    default: null
  }
}, { 
  timestamps: true 
});

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
payoutSchema.index({ userId: 1, status: 1, initiatedAt: -1 });
payoutSchema.index({ status: 1, nextRetryAt: 1 }); // For retry job
payoutSchema.index({ transactionId: 1 }, { sparse: true });

// =============================================
// STATIC METHODS
// =============================================

/**
 * Create payout for user
 */
payoutSchema.statics.createPayout = async function(userId, amount, bookingIds) {
  const User = mongoose.model('User');
  const user = await User.findById(userId).select('paymentInfo');
  
  if (!user || !user.paymentInfo) {
    throw new Error('User payment info not found');
  }
  
  if (user.paymentInfo.upiStatus !== 'verified') {
    throw new Error('UPI not verified');
  }
  
  const payout = await this.create({
    userId,
    amount,
    upiId: user.paymentInfo.upiId,
    upiName: user.paymentInfo.upiName,
    bookingsIncluded: bookingIds,
    status: 'pending'
  });
  
  return payout;
};

/**
 * Process payout via payment gateway
 */
payoutSchema.methods.process = async function() {
  try {
    this.status = 'processing';
    this.processingStartedAt = new Date();
    await this.save();
    
    // Call payment gateway API
    const paymentGateway = require('../services/paymentGateway');
    const result = await paymentGateway.transferToUPI({
      upiId: this.upiId,
      amount: this.amount,
      referenceId: this._id.toString()
    });
    
    if (result.success) {
      this.status = 'completed';
      this.transactionId = result.transactionId;
      this.gatewayResponse = result;
      this.completedAt = new Date();
      
      // Update user's payout balances
      const User = mongoose.model('User');
      await User.findByIdAndUpdate(this.userId, {
        $inc: {
          'paymentInfo.pendingPayout': -this.amount,
          'paymentInfo.completedPayouts': this.amount
        }
      });
      
      // Mark bookings as paid out
      const Booking = mongoose.model('Booking');
      await Booking.updateMany(
        { _id: { $in: this.bookingsIncluded } },
        { earningsPaidOut: true, payoutId: this._id }
      );
      
      // Send email notification
      const emailService = require('../services/email');
      const user = await User.findById(this.userId).select('email firstName');
      await emailService.sendPayoutSuccessEmail(user.email, {
        amount: this.amount,
        transactionId: this.transactionId,
        name: user.firstName
      });
      
    } else {
      this.status = 'failed';
      this.failureReason = result.error || 'Payment gateway error';
      this.gatewayResponse = result;
      
      // Schedule retry
      if (this.retryCount < 3) {
        this.retryCount += 1;
        this.lastRetryAt = new Date();
        this.nextRetryAt = new Date(Date.now() + 60 * 60 * 1000); // Retry in 1 hour
        this.status = 'pending';
      }
    }
    
    await this.save();
    return this.status === 'completed';
    
  } catch (error) {
    console.error('Payout processing error:', error);
    this.status = 'failed';
    this.failureReason = error.message;
    
    if (this.retryCount < 3) {
      this.retryCount += 1;
      this.lastRetryAt = new Date();
      this.nextRetryAt = new Date(Date.now() + 60 * 60 * 1000);
      this.status = 'pending';
    }
    
    await this.save();
    return false;
  }
};

/**
 * Get pending payouts for retry
 */
payoutSchema.statics.getPendingRetries = async function() {
  return this.find({
    status: 'pending',
    retryCount: { $gt: 0, $lt: 3 },
    nextRetryAt: { $lte: new Date() }
  }).populate('userId', 'email firstName');
};

/**
 * Get user's payout history
 */
payoutSchema.statics.getUserPayoutHistory = async function(userId, options = {}) {
  const { page = 1, limit = 10 } = options;
  
  const payouts = await this.find({ userId })
    .sort({ initiatedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('bookingsIncluded', 'bookingDate totalAmount')
    .lean();
  
  const total = await this.countDocuments({ userId });
  
  return {
    payouts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
};

/**
 * Calculate weekly payout for user
 */
payoutSchema.statics.calculateWeeklyPayout = async function(userId) {
  const User = mongoose.model('User');
  const user = await User.findById(userId).select('paymentInfo');
  
  if (!user || user.paymentInfo.pendingPayout < 500) {
    return null; // Minimum payout is ₹500
  }
  
  // Get unpaid bookings
  const Booking = mongoose.model('Booking');
  const unpaidBookings = await Booking.find({
    companionId: userId,
    status: 'completed',
    paymentStatus: 'paid',
    earningsPaidOut: false
  }).select('_id companionEarning').lean();
  
  if (unpaidBookings.length === 0) {
    return null;
  }
  
  const totalAmount = unpaidBookings.reduce((sum, b) => sum + b.companionEarning, 0);
  const bookingIds = unpaidBookings.map(b => b._id);
  
  return {
    amount: totalAmount,
    bookingIds
  };
};

module.exports = mongoose.model('Payout', payoutSchema);
