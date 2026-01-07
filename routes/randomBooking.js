// routes/randomBooking.js - WITH AUTO CITY DETECTION
const express = require('express');
const router = express.Router();
const RandomBooking = require('../models/RandomBooking');
const WeeklyUsage = require('../models/WeeklyUsage');
const RandomBookingChat = require('../models/RandomBookingChat');
const User = require('../models/User');
const Message = require('../models/Message');
const SafetyReport = require('../models/SafetyReport');
const { auth } = require('../middleware/auth');

/**
 * @route   POST /api/random-booking/create
 * @desc    Create random booking (city auto-detected from user profile)
 * @access  Private
 */
router.post('/create', auth, async (req, res) => {
  try {
    const {
      destination,
      city,  // Can be empty - will use user's city
      date,
      timeRange,
      preferredGender,
      ageRange,
      activityType,
      note
    } = req.body;

    console.log('📥 Create booking request:', {
      destination,
      cityFromRequest: city || '(empty)',
      date,
      timeRange,
      preferredGender,
      ageRange,
      activityType,
      hasNote: !!note
    });

    // ✅ CRITICAL: Get user and their city from questionnaire
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Determine final city: use request city if provided, otherwise user's city
    const finalCity = (city && city.trim()) 
      ? city.toLowerCase().trim()
      : user.questionnaire?.city?.toLowerCase().trim() || null;

    console.log('📍 City detection:', {
      fromRequest: city || '(empty)',
      fromProfile: user.questionnaire?.city || '(not set)',
      finalCity: finalCity || '(none)',
      source: (city && city.trim()) ? 'request' : 'user profile'
    });

    if (!finalCity) {
      return res.status(400).json({
        success: false,
        message: 'City is required. Please set your city in profile settings to create random bookings.'
      });
    }

    // Validation of required fields
    if (!destination || !date || !timeRange || 
        !timeRange.start || !timeRange.end ||
        !preferredGender || !ageRange || 
        !ageRange.min || !ageRange.max || !activityType) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    // ✅ Check weekly usage
    const canCreate = await WeeklyUsage.canUserCreateBooking(req.userId);
    
    if (!canCreate.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Weekly limit reached. You can create 1 random booking per week.',
        resetAt: canCreate.resetAt
      });
    }

    // Parse and validate date
    const bookingDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    bookingDate.setHours(0, 0, 0, 0);

    if (bookingDate < today) {
      return res.status(400).json({
        success: false,
        message: 'Booking date cannot be in the past'
      });
    }

    // Calculate expiresAt (24 hours from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // ✅ Create booking with finalCity
    const booking = new RandomBooking({
      initiatorId: req.userId,
      destination,
      city: finalCity,  // ✅ Uses finalCity (from profile if request is empty)
      date: bookingDate,
      timeRange: {
        start: timeRange.start,
        end: timeRange.end
      },
      preferredGender,
      ageRange: {
        min: ageRange.min,
        max: ageRange.max
      },
      activityType,
      note: note || null,
      expiresAt,
      status: 'PENDING'
    });

    await booking.save();
    console.log('✅ Booking created:', {
      id: booking._id,
      city: booking.city,
      destination: booking.destination,
      date: booking.date
    });

    // ✅ Update weekly usage
    const usage = await WeeklyUsage.getOrCreateCurrentWeek(req.userId);
    usage.bookingsCreated += 1;
    await usage.save();

    console.log('✅ Weekly usage updated:', {
      userId: req.userId,
      bookingsCreated: usage.bookingsCreated,
      weekIdentifier: usage.weekIdentifier
    });

    // Populate initiator details
    await booking.populate('initiatorId', 'firstName lastName profilePhoto bio');

    res.status(201).json({
      success: true,
      message: 'Random booking created successfully',
      booking
    });

  } catch (error) {
    console.error('❌ Create random booking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create random booking'
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

    console.log('🔍 Eligible bookings:', {
      userId: req.userId,
      userCity: user.questionnaire?.city,
      count: eligibleBookings.length
    });

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
 * @desc    Accept random booking
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

    if (!booking.isValid()) {
      return res.status(400).json({
        success: false,
        message: 'This booking is no longer available',
        status: booking.status
      });
    }

    const user = await User.findById(req.userId);
    if (!booking.matchesPreferences(user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not match the booking preferences'
      });
    }

    await booking.acceptBooking(req.userId);
    const chat = await RandomBookingChat.createForBooking(booking);

    booking.chatId = chat._id;
    await booking.save();

    console.log(`✅ Booking accepted: ${booking._id} by ${req.userId}`);

    res.json({
      success: true,
      message: 'Booking accepted successfully! Chat created.',
      booking,
      chatId: chat._id
    });

  } catch (error) {
    console.error('Accept booking error:', error);
    
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
    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ success: false, message: 'Failed to load bookings' });
  }
});

/**
 * @route   POST /api/random-booking/:bookingId/cancel
 * @desc    Cancel random booking
 * @access  Private
 */
router.post('/:bookingId/cancel', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.initiatorId.toString() !== req.userId.toString()) {
      return res.status(403).json({ success: false, message: 'Only initiator can cancel booking' });
    }

    await booking.cancel(req.body.reason || 'User cancelled');
    await WeeklyUsage.recordCancellation(req.userId);

    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to cancel booking' });
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
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    await booking.completeMeetup(req.userId);

    if (booking.chatId) {
      const chat = await RandomBookingChat.findById(booking.chatId);
      if (chat) await chat.markCompleted();
    }

    res.json({ success: true, message: 'Meetup marked as completed. Chat will expire tonight.' });
  } catch (error) {
    console.error('Complete booking error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to complete booking' });
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
        bookingsCreated: 0,
        cancellationCount: 0,
        noShowCount: 0
      },
      canCreateBooking: canCreate.allowed,
      remaining: canCreate.remaining,
      resetAt: canCreate.resetAt
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ success: false, message: 'Failed to load usage' });
  }
});

// ==================== CHAT ENDPOINTS ====================

router.get('/chats', auth, async (req, res) => {
  try {
    const chats = await RandomBookingChat.findForUser(req.userId);
    res.json({ success: true, chats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load chats' });
  }
});

router.get('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (!chat.isParticipant(req.userId)) return res.status(403).json({ success: false, message: 'Access denied' });
    if (chat.isExpired()) return res.status(410).json({ success: false, message: 'Chat expired', expired: true });

    const messages = await Message.find({ chatId: req.params.chatId })
      .populate('senderId', 'firstName lastName profilePhoto')
      .sort({ timestamp: 1 });

    res.json({ success: true, messages, expiresAt: chat.expiresAt });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load messages' });
  }
});

router.post('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (!chat.isParticipant(req.userId)) return res.status(403).json({ success: false, message: 'Access denied' });
    if (chat.isExpired()) return res.status(410).json({ success: false, message: 'Chat expired' });

    const message = await Message.create({
      chatId: req.params.chatId,
      senderId: req.userId,
      senderRole: 'USER',
      content: req.body.content,
      messageType: 'TEXT'
    });

    chat.lastMessageAt = new Date();
    await chat.save();

    res.status(201).json({ success: true, message });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

router.post('/chats/:chatId/report', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId).populate('bookingId');
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (chat.isExpired()) return res.status(410).json({ success: false, message: 'Cannot report expired chat' });

    const otherUser = chat.participants.find(p => p.userId.toString() !== req.userId.toString());

    const report = await SafetyReport.create({
      reporterId: req.userId,
      reportedUserId: otherUser.userId,
      category: req.body.category,
      description: req.body.description,
      chatId: chat._id,
      bookingId: chat.bookingId._id
    });

    await chat.flagForReview(report._id);

    res.status(201).json({
      success: true,
      message: 'Report submitted. Chat preserved for review.',
      reportId: report._id
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to submit report' });
  }
});

module.exports = router;
