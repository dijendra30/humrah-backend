// models/Payout.js - Payout Transaction Model
const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  // User receiving payout
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ userId, status, initiatedAt }) below
  },

  // Payout amount
  amount: {
    type: Number,
    required: true,
    min: 0
  },

  // UPI details at time of payout
  upiId:   { type: String, required: true },
  upiName: { type: String, required: true },

  // Payout status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
    // ✅ FIX: index:true removed — covered by compound index({ status, nextRetryAt }) below
  },

  // Payment gateway details
  transactionId: {
    type: String,
    default: null,
    // ✅ FIX: index:true removed — the explicit sparse index below is the correct one.
    // Having both index:true (non-sparse) AND index({ transactionId:1 }, { sparse:true })
    // created two separate indexes on the same field — one non-sparse, one sparse.
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
  initiatedAt:         { type: Date, default: Date.now },
  processingStartedAt: { type: Date, default: null },
  completedAt:         { type: Date, default: null },

  // Failure handling
  failureReason: { type: String, default: null },
  retryCount:    { type: Number, default: 0 },
  lastRetryAt:   { type: Date,   default: null },
  nextRetryAt:   { type: Date,   default: null }

}, {
  timestamps: true
});

// =============================================
// ✅ INDEXES — single source of truth
// =============================================
payoutSchema.index({ userId: 1, status: 1, initiatedAt: -1 });
payoutSchema.index({ status: 1, nextRetryAt: 1 });                       // For retry job
payoutSchema.index({ transactionId: 1 }, { sparse: true });              // Sparse — null values excluded

// =============================================
// STATIC METHODS
// =============================================
payoutSchema.statics.createPayout = async function(userId, amount, bookingIds) {
  const User = mongoose.model('User');
  const user = await User.findById(userId).select('paymentInfo');

  if (!user || !user.paymentInfo) throw new Error('User payment info not found');
  if (user.paymentInfo.upiStatus !== 'verified') throw new Error('UPI not verified');

  return this.create({
    userId,
    amount,
    upiId: user.paymentInfo.upiId,
    upiName: user.paymentInfo.upiName,
    bookingsIncluded: bookingIds,
    status: 'pending'
  });
};

payoutSchema.methods.process = async function() {
  try {
    this.status = 'processing';
    this.processingStartedAt = new Date();
    await this.save();

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

      const User = mongoose.model('User');
      await User.findByIdAndUpdate(this.userId, {
        $inc: {
          'paymentInfo.pendingPayout':    -this.amount,
          'paymentInfo.completedPayouts':  this.amount
        }
      });

      const Booking = mongoose.model('Booking');
      await Booking.updateMany(
        { _id: { $in: this.bookingsIncluded } },
        { earningsPaidOut: true, payoutId: this._id }
      );

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

      if (this.retryCount < 3) {
        this.retryCount += 1;
        this.lastRetryAt = new Date();
        this.nextRetryAt = new Date(Date.now() + 60 * 60 * 1000);
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

payoutSchema.statics.getPendingRetries = async function() {
  return this.find({
    status: 'pending',
    retryCount: { $gt: 0, $lt: 3 },
    nextRetryAt: { $lte: new Date() }
  }).populate('userId', 'email firstName');
};

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
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
};

payoutSchema.statics.calculateWeeklyPayout = async function(userId) {
  const User = mongoose.model('User');
  const user = await User.findById(userId).select('paymentInfo');

  if (!user || user.paymentInfo.pendingPayout < 500) return null;

  const Booking = mongoose.model('Booking');
  const unpaidBookings = await Booking.find({
    companionId: userId,
    status: 'completed',
    paymentStatus: 'paid',
    earningsPaidOut: false
  }).select('_id companionEarning').lean();

  if (unpaidBookings.length === 0) return null;

  const totalAmount = unpaidBookings.reduce((sum, b) => sum + b.companionEarning, 0);
  const bookingIds  = unpaidBookings.map(b => b._id);
  return { amount: totalAmount, bookingIds };
};

module.exports = mongoose.model('Payout', payoutSchema);
