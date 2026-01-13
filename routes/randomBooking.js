// routes/randomBooking.js - FIXED WITH expiresAt
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const RandomBooking = require('../models/RandomBooking');
const RandomBookingChat = require('../models/RandomBookingChat');
const Message = require('../models/Message');
const User = require('../models/User');
const WeeklyUsage = require('../models/WeeklyUsage');

console.log('🔍 DEBUG: Checking auth middleware...');
console.log('🔍 auth type:', typeof auth);
console.log('🔍 auth function:', auth.toString().substring(0, 100));
// ==================== CREATE RANDOM BOOKING ====================
router.post('/create', auth, async (req, res) => {
  try {
    // ✅ ADD THESE DEBUG LOGS AT THE VERY TOP
    console.log('');
    console.log('='.repeat(60));
    console.log('🔍 CREATE BOOKING - DEBUG INFO');
    console.log('='.repeat(60));
    console.log('req.userId:', req.userId);
    console.log('req.user:', req.user ? `${req.user.firstName} ${req.user.lastName}` : 'undefined');
    console.log('req.user._id:', req.user?._id);
    console.log('Authorization header:', req.header('Authorization')?.substring(0, 20) + '...');
    console.log('='.repeat(60));
    console.log('');

    // ✅ SAFETY CHECK: If userId is still undefined, stop and return error
    if (!req.userId) {
      console.error('❌ CRITICAL: req.userId is undefined after auth middleware!');
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: userId not set'
      });
    }

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

    // Check weekly limit
    const usage = await WeeklyUsage.getOrCreateCurrentWeek(req.userId);
    if (usage.bookingsCreated >= 1) {
      return res.status(429).json({
        success: false,
        message: 'You can only create 1 booking per week',
        resetAt: usage.weekEnd
      });
    }

    // Get user's city and area from profile
    const user = await User.findById(req.userId).select('questionnaire');
    const userCity = user.questionnaire?.city;
    const userArea = user.questionnaire?.area;

    // ✅ Calculate expiresAt (24 hours after booking date)
    const bookingDate = new Date(date);
    const expiresAt = new Date(bookingDate);
    expiresAt.setDate(bookingDate.getDate() + 1);
    expiresAt.setHours(23, 59, 59, 999);

    // ✅ DEBUG: Log what we're about to create
    console.log('📝 Creating booking with:');
    console.log('   initiatorId:', req.userId);
    console.log('   destination:', destination);
    console.log('   city:', userCity || city);

    // Create booking
    const booking = await RandomBooking.create({
      initiatorId: req.userId,  // ✅ This should now have a value
      destination,
      city: userCity || city,
      area: userArea,
      date: bookingDate,
      timeRange,
      preferredGender,
      ageRange,
      activityType,
      languagePreference,
      note,
      status: 'PENDING',
      expiresAt
    });

    // ✅ DEBUG: Verify booking was created correctly
    console.log('✅ Booking created:');
    console.log('   _id:', booking._id);
    console.log('   initiatorId:', booking.initiatorId);
    console.log('');

    // Increment usage
    usage.bookingsCreated++;
    await usage.save();

    // Broadcast notification to eligible users
    const { broadcastNewBooking } = require('../utils/broadcastNotification');
    await broadcastNewBooking(booking);

    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      booking
    });
  } catch (error) {
    console.error('❌ Create booking error:', error);
    console.error('   Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create booking'
    });
  }
});
// ==================== GET ELIGIBLE BOOKINGS ====================
router.get('/eligible', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('questionnaire');
    const userCity = user.questionnaire?.city;
    const userGender = user.questionnaire?.gender;
    const userAge = calculateAge(user.questionnaire?.dateOfBirth);

    if (!userCity) {
      return res.json({ success: true, bookings: [] });
    }

    const bookings = await RandomBooking.find({
      initiatorId: { $ne: req.userId },
      status: 'PENDING',
      city: userCity.toLowerCase(),
      date: { $gte: new Date() },
      expiresAt: { $gt: new Date() }
    })
    .populate('initiatorId', 'firstName lastName profilePhoto questionnaire')
    .sort({ createdAt: -1 })
    .limit(20);

    // Filter by gender and age preferences
    const eligible = bookings.filter(booking => {
      const genderMatch = booking.preferredGender === 'ANY' || 
                          booking.preferredGender === userGender;
      const ageMatch = userAge >= booking.ageRange.min && 
                       userAge <= booking.ageRange.max;
      return genderMatch && ageMatch;
    });

    res.json({ success: true, bookings: eligible });
  } catch (error) {
    console.error('Get eligible bookings error:', error);
    res.status(500).json({ success: false, message: 'Failed to load bookings' });
  }
});

// ==================== ACCEPT BOOKING ====================
router.post('/:bookingId/accept', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId)
      .populate('initiatorId', 'firstName lastName profilePhoto');

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Booking no longer available' });
    }

    if (booking.initiatorId._id.toString() === req.userId) {
      return res.status(400).json({ success: false, message: 'Cannot accept your own booking' });
    }

    // Update booking
    booking.status = 'MATCHED';
    booking.acceptedUserId = req.userId;
    booking.matchedAt = new Date();
    await booking.save();

    // Create chat
    const chat = await RandomBookingChat.createForBooking(booking);

    // Update booking with chatId
    booking.chatId = chat._id;
    await booking.save();

    // Notify initiator
    const { notifyBookingAccepted } = require('../utils/broadcastNotification');
    const acceptedUser = await User.findById(req.userId).select('firstName lastName profilePhoto');
    await notifyBookingAccepted(booking, acceptedUser);

    res.json({
      success: true,
      message: 'Booking accepted successfully',
      chatId: chat._id.toString(),
      booking
    });
  } catch (error) {
    console.error('Accept booking error:', error);
    res.status(500).json({ success: false, message: 'Failed to accept booking' });
  }
});

// ==================== GET MY BOOKINGS ====================
router.get('/my-bookings', auth, async (req, res) => {
  try {
    const bookings = await RandomBooking.getUserHistory(req.userId);
    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Get my bookings error:', error);
    res.status(500).json({ success: false, message: 'Failed to load bookings' });
  }
});

// ==================== GET CHATS ====================
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

// ==================== GET MESSAGES (WITH DELIVERY STATUS) ====================
router.get('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    // ✅ Populate sender with profile photo
    const messages = await Message.find({ chatId: req.params.chatId })
      .populate('senderId', 'firstName lastName profilePhoto')
      .sort({ timestamp: 1 });
    
    // ✅ Transform messages to include delivery status
    const transformedMessages = messages.map(msg => ({
      _id: msg._id.toString(),
      chatId: msg.chatId.toString(),
      senderId: msg.senderId._id.toString(),
      senderIdRaw: {
        _id: msg.senderId._id.toString(),
        firstName: msg.senderId.firstName,
        lastName: msg.senderId.lastName,
        profilePhoto: msg.senderId.profilePhoto
      },
      senderRole: msg.senderRole,
      content: msg.content,
      messageType: msg.messageType,
      timestamp: msg.timestamp.toISOString(),
      isSystemMessage: msg.isSystemMessage || false,
      deliveryStatus: msg.deliveryStatus || 'SENT',
      deliveredAt: msg.deliveredAt?.toISOString() || null,
      readAt: msg.readAt?.toISOString() || null
    }));
    
    res.json({ 
      success: true, 
      messages: transformedMessages, 
      expiresAt: chat.expiresAt,
      isExpired: chat.isExpired()
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ success: false, message: 'Failed to load messages' });
  }
});

// ==================== SEND MESSAGE (WITH SOCKET.IO EMIT) ====================
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
    
    // Create message with SENT status
    const message = await Message.create({
      chatId: req.params.chatId,
      senderId: req.userId,
      senderRole: 'USER',
      content: req.body.content,
      messageType: 'TEXT',
      deliveryStatus: 'SENT' // ✅ Initial status
    });
    
    // ✅ Populate sender details
    await message.populate('senderId', 'firstName lastName profilePhoto');
    
    // Update chat lastMessageAt
    chat.lastMessageAt = new Date();
    await chat.save();
    
    // ✅ Emit Socket.IO event for real-time delivery
    const io = req.app.get('io');
    if (io) {
      const messageData = {
        _id: message._id.toString(),
        chatId: message.chatId.toString(),
        senderId: message.senderId._id.toString(),
        senderIdRaw: {
          _id: message.senderId._id.toString(),
          firstName: message.senderId.firstName,
          lastName: message.senderId.lastName,
          profilePhoto: message.senderId.profilePhoto
        },
        senderRole: message.senderRole,
        content: message.content,
        messageType: message.messageType,
        timestamp: message.timestamp.toISOString(),
        isSystemMessage: message.isSystemMessage || false,
        deliveryStatus: 'SENT'
      };
      
      // Emit to chat room
      io.to(req.params.chatId).emit('new-message', messageData);
      
      console.log(`📤 Emitted new message to chat ${req.params.chatId}`);
    }
    
    // Return response
    res.status(201).json({ 
      success: true, 
      message: {
        _id: message._id.toString(),
        chatId: message.chatId.toString(),
        senderId: message.senderId._id.toString(),
        senderIdRaw: {
          _id: message.senderId._id.toString(),
          firstName: message.senderId.firstName,
          lastName: message.senderId.lastName,
          profilePhoto: message.senderId.profilePhoto
        },
        content: message.content,
        messageType: message.messageType,
        timestamp: message.timestamp.toISOString(),
        deliveryStatus: 'SENT'
      }
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

// ==================== REPORT USER ====================
router.post('/chats/:chatId/report', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    if (chat.isDeleted) {
      return res.status(410).json({
        success: false,
        message: 'This conversation has already expired and cannot be reported'
      });
    }

    const { category, description } = req.body;

    // Get the other user
    const otherParticipant = chat.participants.find(p => 
      p.userId.toString() !== req.userId
    );

    if (!otherParticipant) {
      return res.status(400).json({ success: false, message: 'Other user not found' });
    }

    // Create safety report
    const SafetyReport = require('../models/SafetyReport');
    const report = await SafetyReport.create({
      reporterId: req.userId,
      reportedUserId: otherParticipant.userId,
      category,
      description,
      relatedBookingId: chat.bookingId,
      priority: 'HIGH'
    });

    // Flag chat for review
    await chat.flagForReview(report._id);

    res.json({
      success: true,
      message: 'Report submitted successfully',
      reportId: report._id
    });
  } catch (error) {
    console.error('Report user error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit report' });
  }
});

// ==================== CANCEL BOOKING ====================
router.post('/:bookingId/cancel', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);
    
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    
    if (booking.initiatorId.toString() !== req.userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    await booking.cancel(req.body.reason || 'User cancelled');
    
    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel booking' });
  }
});

// ==================== COMPLETE BOOKING ====================
router.post('/:bookingId/complete', auth, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);
    
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    
    await booking.completeMeetup(req.userId);
    
    res.json({ success: true, message: 'Booking completed successfully' });
  } catch (error) {
    console.error('Complete booking error:', error);
    res.status(500).json({ success: false, message: 'Failed to complete booking' });
  }
});

// ==================== GET WEEKLY USAGE ====================
router.get('/usage', auth, async (req, res) => {
  try {
    const result = await WeeklyUsage.canUserCreateBooking(req.userId);
    const usage = await WeeklyUsage.getUserUsage(req.userId);
    
    res.json({
      success: true,
      usage: usage || { bookingsCreated: 0, cancellationCount: 0, noShowCount: 0 },
      canCreateBooking: result.allowed,
      remaining: result.remaining,
      resetAt: result.resetAt.toISOString()
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ success: false, message: 'Failed to load usage' });
  }
});

// ==================== HELPER FUNCTIONS ====================
function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return 25; // Default
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

module.exports = router;
