// routes/randomBooking.js - WITH BROADCAST NOTIFICATION
const express = require('express');
const router = express.Router();
const RandomBooking = require('../models/RandomBooking');
const WeeklyUsage = require('../models/WeeklyUsage');
const RandomBookingChat = require('../models/RandomBookingChat');
const User = require('../models/User');
const Message = require('../models/Message');
const SafetyReport = require('../models/SafetyReport');
const { auth } = require('../middleware/auth');
const { broadcastNewBooking, notifyBookingAccepted } = require('../utils/broadcastNotification');

/**
 * @route   POST /api/random-booking/create
 * @desc    Create random booking and broadcast to same city users
 * @access  Private
 */
router.post('/create', auth, async (req, res) => {
  try {
    const {
      destination,
      date,
      timeRange,
      preferredGender,
      ageRange,
      activityType,
      note
    } = req.body;

    console.log('📥 Create booking request from user:', req.userId);

    // Get user and normalize city
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const city = user.questionnaire?.city?.trim().toLowerCase();
    const area = user.questionnaire?.area?.trim().toLowerCase();

    if (!city) {
      return res.status(400).json({
        success: false,
        message: 'Please set your city in profile settings to create random bookings.'
      });
    }

    console.log('📍 User location:', { city, area: area || '(not set)' });

    // Validation
    if (!destination || !date || !timeRange || 
        !timeRange.start || !timeRange.end ||
        !preferredGender || !ageRange || 
        !ageRange.min || !ageRange.max || !activityType) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    // Check weekly usage
    const canCreate = await WeeklyUsage.canUserCreateBooking(req.userId);
    
    if (!canCreate.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Weekly limit reached. You can create 1 random booking per week.',
        resetAt: canCreate.resetAt
      });
    }

    // Parse date
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

    // Create booking
    const booking = new RandomBooking({
      initiatorId: req.userId,
      destination,
      city,
      area,
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
      area: booking.area
    });

    // Update weekly usage
    const usage = await WeeklyUsage.getOrCreateCurrentWeek(req.userId);
    usage.bookingsCreated += 1;
    await usage.save();

    // ✅ BROADCAST: Send notification to all users in same city
    // Uses EXACT same logic as Spotlight controller
    try {
      const broadcastResult = await broadcastNewBooking(booking);
      console.log('📢 Broadcast result:', broadcastResult);
    } catch (broadcastError) {
      // Don't fail booking creation if broadcast fails
      console.error('⚠️ Broadcast error (non-fatal):', broadcastError);
    }

    // Populate initiator details
    await booking.populate('initiatorId', 'firstName lastName profilePhoto bio');

    res.status(201).json({
      success: true,
      message: 'Random booking created successfully',
      booking
    });

  } catch (error) {
    console.error('❌ Create booking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create random booking'
    });
  }
});

/**
 * @route   GET /api/random-booking/eligible
 * @desc    Get eligible bookings for current user (SAME CITY ONLY)
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

    const userCity = user.questionnaire?.city?.trim().toLowerCase();

    if (!userCity) {
      return res.json({
        success: true,
        bookings: [],
        message: 'Please set your city in profile to see bookings'
      });
    }

    console.log('🔍 Finding bookings for user:', { userId: req.userId, city: userCity });

    // ✅ Simple query: SAME CITY only (exact match, normalized)
    const bookings = await RandomBooking.find({
      city: userCity,
      status: 'PENDING',
      expiresAt: { $gt: new Date() },
      date: { $gt: new Date() },
      initiatorId: { $ne: user._id }
    })
    .populate('initiatorId', 'firstName lastName profilePhoto questionnaire')
    .sort({ createdAt: -1 });

    console.log(`📡 Found ${bookings.length} bookings in city: ${userCity}`);

    // Filter by preferences
    const eligibleBookings = bookings.filter(booking => {
      if (booking.preferredGender !== 'ANY') {
        const userGender = user.questionnaire?.gender?.toUpperCase();
        if (userGender !== booking.preferredGender) return false;
      }

      if (user.questionnaire?.dateOfBirth) {
        const age = calculateAge(user.questionnaire.dateOfBirth);
        if (age < booking.ageRange.min || age > booking.ageRange.max) return false;
      }

      return true;
    });

    console.log(`✅ ${eligibleBookings.length} bookings match user preferences`);

    res.json({
      success: true,
      bookings: eligibleBookings
    });

  } catch (error) {
    console.error('❌ Get eligible bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load eligible bookings'
    });
  }
});

/**
 * @route   POST /api/random-booking/:bookingId/accept
 * @desc    Accept booking and notify initiator
 * @access  Private
 */
router.post('/:bookingId/accept', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId)
      .populate('initiatorId', 'firstName lastName profilePhoto email questionnaire');

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
    
    // Validate city match
    const userCity = user.questionnaire?.city?.trim().toLowerCase();
    const bookingCity = booking.city;

    if (userCity !== bookingCity) {
      console.log('❌ City mismatch:', { userCity, bookingCity });
      return res.status(403).json({
        success: false,
        message: 'You are not eligible for this booking'
      });
    }

    // Additional preference checks
    if (booking.preferredGender !== 'ANY') {
      const userGender = user.questionnaire?.gender?.toUpperCase();
      if (userGender !== booking.preferredGender) {
        return res.status(403).json({
          success: false,
          message: 'You do not match the booking preferences'
        });
      }
    }

    if (user.questionnaire?.dateOfBirth) {
      const age = calculateAge(user.questionnaire.dateOfBirth);
      if (age < booking.ageRange.min || age > booking.ageRange.max) {
        return res.status(403).json({
          success: false,
          message: 'You do not match the booking age range'
        });
      }
    }

    // Accept booking
    await booking.acceptBooking(req.userId);
    const chat = await RandomBookingChat.createForBooking(booking);

    booking.chatId = chat._id;
    await booking.save();

    console.log('✅ Booking accepted:', { bookingId: booking._id, acceptedBy: req.userId });

    // ✅ NOTIFY: Send notification to booking initiator
    try {
      const notifyResult = await notifyBookingAccepted(booking, user);
      console.log('📤 Notify result:', notifyResult);
    } catch (notifyError) {
      console.error('⚠️ Notify error (non-fatal):', notifyError);
    }

    res.json({
      success: true,
      message: 'Booking accepted successfully! Chat created.',
      booking,
      chatId: chat._id
    });

  } catch (error) {
    console.error('❌ Accept booking error:', error);
    
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

// ==================== OTHER ENDPOINTS (unchanged) ====================

router.get('/my-bookings', auth, async (req, res) => {
  try {
    const bookings = await RandomBooking.getUserHistory(req.userId);
    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ success: false, message: 'Failed to load bookings' });
  }
});

router.post('/:bookingId/cancel', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
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

router.post('/:bookingId/complete', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
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

// Chat endpoints
router.get('/chats', auth, async (req, res) => {
  try {
    const chats = await RandomBookingChat.find({
      'participants.userId': req.userId,
      isDeleted: false
    })
    .populate({
      path: 'participants.userId',
      select: 'firstName lastName profilePhoto'
    })
    .populate({
      path: 'bookingId',
      select: 'destination city date activityType'
    })
    .sort({ lastMessageAt: -1 });

    res.json({ success: true, chats });
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ success: false, message: 'Failed to load chats' });
  }
});

// ✅ GET /chats/:chatId/messages - WITH POPULATED SENDER
router.get('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const messages = await Message.find({ chatId: req.params.chatId })
      .populate('senderId', 'firstName lastName profilePhoto')
      .sort({ timestamp: 1 });
    
    res.json({ 
      success: true, 
      messages, 
      expiresAt: chat.expiresAt 
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ success: false, message: 'Failed to load messages' });
  }
});

// ✅ POST /chats/:chatId/messages - WITH SOCKET.IO EMIT
router.post('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    if (chat.isExpired()) {
      return res.status(410).json({ success: false, message: 'Chat expired' });
    }
    
    // Create message
    const message = await Message.create({
      chatId: req.params.chatId,
      senderId: req.userId,
      senderRole: 'USER',
      content: req.body.content,
      messageType: 'TEXT'
    });
    
    // Populate sender details
    await message.populate('senderId', 'firstName lastName profilePhoto');
    
    // Update chat lastMessageAt
    chat.lastMessageAt = new Date();
    await chat.save();
    
    // ✅ Emit Socket.IO event for real-time update
    const io = req.app.get('io');
    if (io) {
      io.to(req.params.chatId).emit('new-message', {
        _id: message._id,
        chatId: message.chatId,
        senderId: message.senderId._id,
        senderIdRaw: {
          _id: message.senderId._id,
          firstName: message.senderId.firstName,
          lastName: message.senderId.lastName,
          profilePhoto: message.senderId.profilePhoto
        },
        senderRole: message.senderRole,
        content: message.content,
        messageType: message.messageType,
        timestamp: message.timestamp,
        isSystemMessage: message.isSystemMessage
      });
      
      console.log(`📤 Emitted new message to chat ${req.params.chatId}`);
    }
    
    res.status(201).json({ success: true, message });
  } catch (error) {
    console.error('Send message error:', error);
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

function calculateAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

module.exports = router;
