// routes/payment.js - UPI Setup and Payout Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Payout = require('../models/Payout');

// @route   POST /api/payment/setup-upi
// @desc    Set up or update UPI ID
// @access  Private
router.post('/setup-upi', auth, async (req, res) => {
  try {
    const { upiId } = req.body;
    
    // Validate UPI format
    const upiRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
    if (!upiRegex.test(upiId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid UPI ID format'
      });
    }
    
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if UPI is already used by another verified user
    const existingUser = await User.findOne({
      _id: { $ne: req.userId },
      'paymentInfo.upiId': upiId,
      'paymentInfo.upiStatus': 'verified'
    });
    
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'This UPI ID is already registered with another account'
      });
    }
    
    // Initialize paymentInfo if not exists
    if (!user.paymentInfo) {
      user.paymentInfo = {
        totalEarnings: 0,
        pendingPayout: 0,
        completedPayouts: 0
      };
    }
    
    // Update UPI info
    user.paymentInfo.upiId = upiId;
    user.paymentInfo.upiStatus = 'pending_verification';
    user.paymentInfo.upiLastUpdated = new Date();
    user.paymentInfo.upiVerificationAttempts = (user.paymentInfo.upiVerificationAttempts || 0) + 1;
    
    await user.save();
    
    // Verify UPI with payment gateway
    const paymentGateway = require('../services/paymentGateway');
    const verificationResult = await paymentGateway.verifyUPI(upiId);
    
    if (verificationResult.success) {
      user.paymentInfo.upiStatus = 'verified';
      user.paymentInfo.upiName = verificationResult.name;
      user.paymentInfo.upiVerifiedAt = new Date();
      await user.save();
      
      res.json({
        success: true,
        message: 'UPI verified successfully',
        upiStatus: 'verified',
        upiName: verificationResult.name
      });
    } else {
      user.paymentInfo.upiStatus = 'failed';
      await user.save();
      
      res.status(400).json({
        success: false,
        message: verificationResult.error || 'UPI verification failed',
        upiStatus: 'failed'
      });
    }
    
  } catch (error) {
    console.error('Setup UPI error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/payment/upi-status
// @desc    Get current UPI status
// @access  Private
router.get('/upi-status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('paymentInfo');
    
    if (!user || !user.paymentInfo) {
      return res.json({
        success: true,
        upiStatus: 'not_set',
        upiId: null
      });
    }
    
    res.json({
      success: true,
      upiStatus: user.paymentInfo.upiStatus,
      upiId: user.paymentInfo.upiId,
      upiName: user.paymentInfo.upiName,
      verifiedAt: user.paymentInfo.upiVerifiedAt
    });
    
  } catch (error) {
    console.error('Get UPI status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/payment/verify-upi-name
// @desc    Verify UPI name matches user's name
// @access  Private
router.post('/verify-upi-name', auth, async (req, res) => {
  try {
    const { confirmed } = req.body;
    
    const user = await User.findById(req.userId);
    
    if (!user || !user.paymentInfo || !user.paymentInfo.upiName) {
      return res.status(400).json({
        success: false,
        message: 'UPI not set up'
      });
    }
    
    // Check name similarity
    const fullName = `${user.firstName} ${user.lastName}`.toLowerCase();
    const upiName = user.paymentInfo.upiName.toLowerCase();
    
    const similarity = calculateNameSimilarity(fullName, upiName);
    
    if (similarity < 0.5 && !confirmed) {
      return res.json({
        success: false,
        requiresConfirmation: true,
        message: 'UPI name does not match your profile name',
        upiName: user.paymentInfo.upiName,
        profileName: `${user.firstName} ${user.lastName}`,
        similarity: Math.round(similarity * 100)
      });
    }
    
    res.json({
      success: true,
      message: 'Name verified'
    });
    
  } catch (error) {
    console.error('Verify UPI name error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/payment/earnings
// @desc    Get earnings dashboard data
// @access  Private
router.get('/earnings', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('paymentInfo ratingStats questionnaire');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if user is a companion
    const isCompanion = user.questionnaire?.becomeCompanion === "Yes, I'm interested";
    if (!isCompanion) {
      return res.status(403).json({
        success: false,
        message: 'Earnings dashboard is only available for companions'
      });
    }
    
    // Calculate this month's earnings
    const Booking = require('../models/Booking');
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const thisMonthBookings = await Booking.find({
      companionId: req.userId,
      status: 'completed',
      paymentStatus: 'paid',
      updatedAt: { $gte: startOfMonth }
    }).select('companionEarning');
    
    const thisMonthEarnings = thisMonthBookings.reduce((sum, b) => sum + b.companionEarning, 0);
    
    // Calculate next payout date
    const nextPayoutDate = calculateNextPayoutDate(user.paymentInfo?.pendingPayout || 0);
    
    res.json({
      success: true,
      summary: {
        totalEarnings: user.paymentInfo?.totalEarnings || 0,
        pendingPayout: user.paymentInfo?.pendingPayout || 0,
        completedPayouts: user.paymentInfo?.completedPayouts || 0,
        thisMonth: thisMonthEarnings
      },
      nextPayout: nextPayoutDate ? {
        amount: user.paymentInfo?.pendingPayout || 0,
        scheduledDate: nextPayoutDate,
        status: user.paymentInfo?.pendingPayout >= 500 ? 'scheduled' : 'below_minimum'
      } : null,
      upiStatus: user.paymentInfo?.upiStatus || 'not_set'
    });
    
  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/payment/earnings/history
// @desc    Get detailed earnings history
// @access  Private
router.get('/earnings/history', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    
    const Booking = require('../models/Booking');
    
    const bookings = await Booking.find({
      companionId: req.userId,
      status: 'completed',
      paymentStatus: 'paid'
    })
    .populate('userId', 'firstName lastName profilePhoto')
    .sort({ updatedAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit))
    .lean();
    
    const total = await Booking.countDocuments({
      companionId: req.userId,
      status: 'completed',
      paymentStatus: 'paid'
    });
    
    const history = bookings.map(booking => ({
      bookingId: booking._id,
      date: booking.bookingDate,
      completedAt: booking.updatedAt,
      bookerName: booking.userId ? `${booking.userId.firstName} ${booking.userId.lastName}` : 'Deleted User',
      bookerPhoto: booking.userId?.profilePhoto || null,
      duration: calculateDuration(booking.bookingDate, booking.updatedAt),
      bookingAmount: booking.totalAmount,
      platformFee: booking.platformFee,
      yourEarning: booking.companionEarning,
      payoutStatus: booking.earningsPaidOut ? 'paid' : 'pending',
      payoutDate: booking.earningsPaidOut ? booking.payoutDate : null
    }));
    
    res.json({
      success: true,
      history,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get earnings history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/payment/payouts
// @desc    Get payout history
// @access  Private
router.get('/payouts', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    
    const result = await Payout.getUserPayoutHistory(req.userId, {
      page: parseInt(page),
      limit: parseInt(limit)
    });
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    console.error('Get payouts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// ADMIN ROUTES
// =============================================

// @route   POST /api/payment/admin/trigger-payout/:userId
// @desc    Manually trigger payout for a user (admin)
// @access  Private (Admin only)
router.post('/admin/trigger-payout/:userId', auth, async (req, res) => {
  try {
    // Check admin permission
    if (req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Super admin access required'
      });
    }
    
    const user = await User.findById(req.params.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    if (!user.paymentInfo || user.paymentInfo.pendingPayout <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No pending payout'
      });
    }
    
    if (user.paymentInfo.upiStatus !== 'verified') {
      return res.status(400).json({
        success: false,
        message: 'UPI not verified'
      });
    }
    
    // Get unpaid bookings
    const Booking = require('../models/Booking');
    const unpaidBookings = await Booking.find({
      companionId: req.params.userId,
      status: 'completed',
      paymentStatus: 'paid',
      earningsPaidOut: false
    }).select('_id');
    
    const bookingIds = unpaidBookings.map(b => b._id);
    
    // Create payout
    const payout = await Payout.createPayout(
      req.params.userId,
      user.paymentInfo.pendingPayout,
      bookingIds
    );
    
    // Process immediately
    const success = await payout.process();
    
    res.json({
      success,
      message: success ? 'Payout processed successfully' : 'Payout failed',
      payout: {
        payoutId: payout._id,
        amount: payout.amount,
        status: payout.status,
        transactionId: payout.transactionId
      }
    });
    
  } catch (error) {
    console.error('Admin trigger payout error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Calculate name similarity (simple implementation)
 */
function calculateNameSimilarity(name1, name2) {
  // Remove common prefixes/suffixes
  const clean = (str) => str.replace(/\b(mr|mrs|ms|dr|prof)\b\.?/gi, '').trim();
  
  const n1 = clean(name1);
  const n2 = clean(name2);
  
  // Check if all words from one name appear in the other
  const words1 = n1.split(/\s+/);
  const words2 = n2.split(/\s+/);
  
  let matches = 0;
  for (const word of words1) {
    if (words2.some(w => w.includes(word) || word.includes(w))) {
      matches++;
    }
  }
  
  return matches / words1.length;
}

/**
 * Calculate next payout date based on balance
 */
function calculateNextPayoutDate(balance) {
  if (balance >= 500) {
    // Next Monday
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilMonday);
    nextMonday.setHours(9, 0, 0, 0);
    return nextMonday;
  } else {
    // First of next month
    const today = new Date();
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    nextMonth.setHours(9, 0, 0, 0);
    return nextMonth;
  }
}

/**
 * Calculate booking duration
 */
function calculateDuration(startDate, endDate) {
  const hours = Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60));
  return `${hours} hour${hours !== 1 ? 's' : ''}`;
}

module.exports = router;
