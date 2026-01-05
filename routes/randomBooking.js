// routes/randomBooking.js - Random Booking Routes
const express = require('express');
const router = express.Router();
const RandomBooking = require('../models/RandomBooking');
const WeeklyUsage = require('../models/WeeklyUsage');
const RandomBookingChat = require('../models/RandomBookingChat');
const User = require('../models/User');
const Message = require('../models/Message');
const SafetyReport = require('../models/SafetyReport');
const { auth } = require('../middleware/auth');

// ==================== USER ENDPOINTS ====================

/**
 * @route   POST /api/random-booking/create
 * @desc    Create random booking
 * @access  Private
 */
router.post('/create', auth, async (req, res) => {
  try {
    const {
      destination,
      city,
      date,
      timeRange,
      preferredGender,
      ageRange,
      activityType,
      languagePreference,
      note
    } = req.body;

    // Validation
    if (!destination || !city || !date || !timeRange || !preferredGender || 
        !ageRange || !activityType) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    // Check weekly limit
    const usage = await WeeklyUsage.canUserCreateBooking(req.userId);
    if (!usage.allowed) {
      return res.status(403).json({
        success: false,
        message: 'You have reached your weekly limit (1 random booking per week)',
        remaining: 0,
        resetAt: usage.resetAt
      });
    }

    // Validate date is not in past
    const bookingDate = new Date(date);
    if (bookingDate < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Booking date cannot be in the past'
      });
    }

    // Create booking
    const booking = await RandomBooking.create({
      initiatorId: req.userId,
      destination,
      city,
      date: bookingDate,
      timeRange,
      preferredGender,
      ageRange,
      activityType,
      languagePreference,
      note
    });

    // Record usage
    await WeeklyUsage.recordBooking(req.userId);

    // Find eligible users for broadcasting
    const initiator = await User.findById(req.userId);
    const eligibleUsers = await RandomBooking.findEligibleForUser(initiator);

    console.log(`🎲 Random Booking Created: ${booking._id} by ${initiator.email}`);

    res.status(201).json({
      success: true,
      message: 'Random booking created successfully',
      booking,
      eligibleUsersCount: eligibleUsers.length
    });

  } catch (error) {
    console.error('Create random booking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create booking'
    });
  }
});

/**
 * @route   GET /api/random-booking/eligible
 * @desc    Get eligible bookings for current user
 * @access  Private
 */
router.get('/eligible', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const eligibleBookings = await RandomBooking.findEligibleForUser(user);

    res.json({
      success: true,
      bookings: eligibleBookings
    });

  } catch (error) {
    console.error('Get eligible bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load eligible bookings'
    });
  }
});

/**
 * @route   POST /api/random-booking/:bookingId/accept
 * @desc    Accept random booking (first-come-first-served)
 * @access  Private
 */
router.post('/:bookingId/accept', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId)
      .populate('initiatorId', 'firstName lastName profilePhoto email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if still valid
    if (!booking.isValid()) {
      return res.status(400).json({
        success: false,
        message: 'This booking is no longer available',
        status: booking.status
      });
    }

    // Check if user is eligible
    const user = await User.findById(req.userId);
    if (!booking.matchesPreferences(user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not match the booking preferences'
      });
    }

    // Accept booking (atomic operation)
    await booking.acceptBooking(req.userId);

    // Create temporary encrypted chat
    const chat = await RandomBookingChat.createForBooking(booking);

    // Update booking with chat ID
    booking.chatId = chat._id;
    await booking.save();

    console.log(`✅ Booking Accepted: ${booking._id} by ${user.email}`);

    res.json({
      success: true,
      message: 'Booking accepted successfully! Chat created.',
      booking,
      chatId: chat._id
    });

  } catch (error) {
    console.error('Accept booking error:', error);
    
    // Handle race condition
    if (error.message === 'Booking is no longer available') {
      return res.status(409).json({
        success: false,
        message: 'Someone else accepted this booking first'
      });
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to accept booking'
    });
  }
});

/**
 * @route   GET /api/random-booking/my-bookings
 * @desc    Get user's booking history
 * @access  Private
 */
router.get('/my-bookings', auth, async (req, res) => {
  try {
    const bookings = await RandomBooking.getUserHistory(req.userId);

    res.json({
      success: true,
      bookings
    });

  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load bookings'
    });
  }
});

/**
 * @route   POST /api/random-booking/:bookingId/cancel
 * @desc    Cancel random booking (initiator only)
 * @access  Private
 */
router.post('/:bookingId/cancel', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if user is initiator
    if (booking.initiatorId.toString() !== req.userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only initiator can cancel booking'
      });
    }

    // Cancel booking
    await booking.cancel(req.body.reason || 'User cancelled');

    // Record cancellation
    await WeeklyUsage.recordCancellation(req.userId);

    res.json({
      success: true,
      message: 'Booking cancelled successfully'
    });

  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel booking'
    });
  }
});

/**
 * @route   POST /api/random-booking/:bookingId/complete
 * @desc    Mark meetup as completed
 * @access  Private
 */
router.post('/:bookingId/complete', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Mark as completed
    await booking.completeMeetup(req.userId);

    // Mark chat as completed (triggers expiry)
    if (booking.chatId) {
      const chat = await RandomBookingChat.findById(booking.chatId);
      if (chat) {
        await chat.markCompleted();
      }
    }

    res.json({
      success: true,
      message: 'Meetup marked as completed. Chat will expire tonight.'
    });

  } catch (error) {
    console.error('Complete booking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to complete booking'
    });
  }
});

/**
 * @route   GET /api/random-booking/usage
 * @desc    Check weekly usage limit
 * @access  Private
 */
router.get('/usage', auth, async (req, res) => {
  try {
    const usage = await WeeklyUsage.getUserUsage(req.userId);
    const canCreate = await WeeklyUsage.canUserCreateBooking(req.userId);

    res.json({
      success: true,
      usage: usage || {
        randomBookingsCreated: 0,
        cancellationCount: 0,
        noShowCount: 0
      },
      canCreateBooking: canCreate.allowed,
      remaining: canCreate.remaining || 0,
      resetAt: canCreate.resetAt
    });

  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load usage'
    });
  }
});

// ==================== CHAT ENDPOINTS ====================

/**
 * @route   GET /api/random-booking/chats
 * @desc    Get user's active chats
 * @access  Private
 */
router.get('/chats', auth, async (req, res) => {
  try {
    const chats = await RandomBookingChat.findForUser(req.userId);

    res.json({
      success: true,
      chats
    });

  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load chats'
    });
  }
});

/**
 * @route   GET /api/random-booking/chats/:chatId/messages
 * @desc    Get chat messages
 * @access  Private
 */
router.get('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // Check if user is participant
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if chat expired
    if (chat.isExpired()) {
      return res.status(410).json({
        success: false,
        message: 'This chat has expired',
        expired: true
      });
    }

    // Get messages
    const messages = await Message.find({ chatId: req.params.chatId })
      .populate('senderId', 'firstName lastName profilePhoto')
      .sort({ timestamp: 1 });

    res.json({
      success: true,
      messages,
      expiresAt: chat.expiresAt,
      isExpired: chat.isExpired()
    });

  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load messages'
    });
  }
});

/**
 * @route   POST /api/random-booking/chats/:chatId/messages
 * @desc    Send message in chat
 * @access  Private
 */
router.post('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // Check if user is participant
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if chat expired
    if (chat.isExpired()) {
      return res.status(410).json({
        success: false,
        message: 'Cannot send message: chat has expired'
      });
    }

    // Create message
    const message = await Message.create({
      chatId: req.params.chatId,
      senderId: req.userId,
      senderRole: 'USER',
      content: req.body.content,
      messageType: 'TEXT'
    });

    // Update chat last message time
    chat.lastMessageAt = new Date();
    await chat.save();

    res.status(201).json({
      success: true,
      message
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message'
    });
  }
});

/**
 * @route   POST /api/random-booking/chats/:chatId/report
 * @desc    Report user in chat (prevents auto-deletion)
 * @access  Private
 */
router.post('/chats/:chatId/report', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId)
      .populate('bookingId');

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // Check if chat expired (cannot report after expiry)
    if (chat.isExpired()) {
      return res.status(410).json({
        success: false,
        message: 'Cannot report: chat has expired'
      });
    }

    // Find the other user in chat
    const otherUser = chat.participants.find(p => 
      p.userId.toString() !== req.userId.toString()
    );

    // Create safety report
    const report = await SafetyReport.create({
      reporterId: req.userId,
      reportedUserId: otherUser.userId,
      category: req.body.category,
      description: req.body.description,
      chatId: chat._id,
      bookingId: chat.bookingId._id
    });

    // Flag chat for review (prevents deletion)
    await chat.flagForReview(report._id);

    res.status(201).json({
      success: true,
      message: 'Report submitted successfully. Chat will be preserved for review.',
      reportId: report._id
    });

  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit report'
    });
  }
});

// ==================== ADMIN ENDPOINTS ====================

/**
 * @route   GET /api/random-booking/admin/all
 * @desc    Get all bookings (admin)
 * @access  Private + Admin
 */
router.get('/admin/all', auth, async (req, res) => {
  try {
    // TODO: Add admin check middleware

    const { status, city, page = 1, limit = 50 } = req.query;
    const query = {};
    
    if (status) query.status = status;
    if (city) query.city = new RegExp(`^${city}$`, 'i');

    const bookings = await RandomBooking.find(query)
      .populate('initiatorId', 'firstName lastName email')
      .populate('acceptedUserId', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await RandomBooking.countDocuments(query);

    res.json({
      success: true,
      bookings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total
      }
    });

  } catch (error) {
    console.error('Get all bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load bookings'
    });
  }
});

/**
 * @route   GET /api/random-booking/admin/statistics
 * @desc    Get booking statistics
 * @access  Private + Admin
 */
router.get('/admin/statistics', auth, async (req, res) => {
  try {
    // TODO: Add admin check middleware

    const stats = await WeeklyUsage.getStatistics();
    
    const [
      totalBookings,
      pendingBookings,
      matchedBookings,
      expiredBookings
    ] = await Promise.all([
      RandomBooking.countDocuments(),
      RandomBooking.countDocuments({ status: 'PENDING' }),
      RandomBooking.countDocuments({ status: 'MATCHED' }),
      RandomBooking.countDocuments({ status: 'EXPIRED' })
    ]);

    res.json({
      success: true,
      weeklyStats: stats,
      totalBookings,
      pendingBookings,
      matchedBookings,
      expiredBookings
    });

  } catch (error) {
    console.error('Get statistics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load statistics'
    });
  }
});

/**
 * @route   GET /api/random-booking/admin/reported-chats
 * @desc    Get chats under review
 * @access  Private + Admin
 */
router.get('/admin/reported-chats', auth, async (req, res) => {
  try {
    // TODO: Add admin check middleware

    const chats = await RandomBookingChat.findUnderReview();

    res.json({
      success: true,
      chats
    });

  } catch (error) {
    console.error('Get reported chats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load reported chats'
    });
  }
});

module.exports = router;
