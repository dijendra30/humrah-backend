// routes/randomBooking.js - GPS-BASED DISTANCE MATCHING
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const RandomBooking = require('../models/RandomBooking');
const BookingMatch = require('../models/BookingMatch');
const RandomBookingChat = require('../models/RandomBookingChat');
const Message = require('../models/Message');
const User = require('../models/User');

// ==================== HELPER: CALCULATE DISTANCE ====================
/**
 * Calculate distance between two GPS coordinates using Haversine formula
 * Returns distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  return distance;
}

function toRad(value) {
  return value * Math.PI / 180;
}

// ==================== HELPER: VALIDATE GPS CITY ====================
/**
 * Validate that user's GPS location matches their selected city
 * Uses reverse geocoding or city boundary checks
 */
async function validateCityLocation(lat, lng, selectedCity) {
  // TODO: Implement reverse geocoding via Google Maps API or similar
  // For now, simplified validation
  
  // City boundary definitions (example for major Indian cities)
  const cityBoundaries = {
    'Delhi': { 
      center: { lat: 28.7041, lng: 77.1025 },
      radius: 30 // km
    },
    'Mumbai': { 
      center: { lat: 19.0760, lng: 72.8777 },
      radius: 25
    },
    'Bangalore': { 
      center: { lat: 12.9716, lng: 77.5946 },
      radius: 30
    },
    'Hyderabad': { 
      center: { lat: 17.3850, lng: 78.4867 },
      radius: 25
    },
    'Chennai': { 
      center: { lat: 13.0827, lng: 80.2707 },
      radius: 25
    }
  };

  const city = cityBoundaries[selectedCity];
  if (!city) {
    // City not in our database - allow for now
    console.warn(`⚠️ City ${selectedCity} not in boundary database`);
    return true;
  }

  const distance = calculateDistance(
    lat, lng,
    city.center.lat, city.center.lng
  );

  const isWithinCity = distance <= city.radius;
  
  console.log(`📍 GPS Validation:`);
  console.log(`   Selected City: ${selectedCity}`);
  console.log(`   GPS: ${lat}, ${lng}`);
  console.log(`   Distance from center: ${distance.toFixed(2)} km`);
  console.log(`   Within boundary: ${isWithinCity}`);

  return isWithinCity;
}

// ==================== CREATE RANDOM BOOKING (GPS-BASED) ====================
router.post('/create', auth, async (req, res) => {
  try {
    console.log('');
    console.log('='.repeat(60));
    console.log('📝 CREATE RANDOM BOOKING (GPS-BASED)');
    console.log('='.repeat(60));

    const user = await User.findById(req.userId).select(
      'random_trial_used isVerified home_city questionnaire'
    );

    // ✅ VALIDATION: User must be verified
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Only verified users can create Random Meet requests. Please complete verification.'
      });
    }

    // ✅ VALIDATION: Free trial not used
    if (user.random_trial_used) {
      return res.status(403).json({
        success: false,
        message: 'You have already used your one-time free Random Meet trial.'
      });
    }

    const {
      city,              // User-confirmed city
      lat,               // Fresh GPS latitude
      lng,               // Fresh GPS longitude
      activityType,
      startTime,
      endTime,
      locationCategory   // Park, Mall, Cafe, Event Venue
    } = req.body;

    console.log('📋 Request Data:');
    console.log('   City:', city);
    console.log('   GPS:', lat, lng);
    console.log('   Activity:', activityType);
    console.log('   Time:', startTime, '-', endTime);

    // ✅ VALIDATION: Required fields
    if (!city || !lat || !lng || !activityType || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: city, GPS coordinates, activity, and time required'
      });
    }

    // ✅ VALIDATION: GPS coordinates valid
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid GPS coordinates'
      });
    }

    // ✅ VALIDATION: Time range (safe hours only)
    const startHour = parseInt(startTime.split(':')[0]);
    const endHour = parseInt(endTime.split(':')[0]);
    
    if (startHour < 10 || endHour > 19 || startHour >= endHour) {
      return res.status(400).json({
        success: false,
        message: 'Bookings only allowed between 10:00 AM and 7:30 PM'
      });
    }

    // ✅ CRITICAL: Validate GPS city matches selected city
    const isInCity = await validateCityLocation(lat, lng, city);
    
    if (!isInCity) {
      console.log('❌ GPS city mismatch!');
      return res.status(400).json({
        success: false,
        message: 'You need to be in this city to request a Random Meet. Your current location does not match the selected city.'
      });
    }

    console.log('✅ GPS validation passed');

    // ✅ VALIDATION: Time must be today or near future
    const now = new Date();
    const bookingStart = new Date();
    const [startHourParsed, startMinute] = startTime.split(':').map(Number);
    bookingStart.setHours(startHourParsed, startMinute, 0, 0);

    if (bookingStart < now) {
      return res.status(400).json({
        success: false,
        message: 'Start time must be in the future'
      });
    }

    // Allow same-day or next day only
    const maxDate = new Date(now);
    maxDate.setDate(now.getDate() + 1);
    maxDate.setHours(23, 59, 59, 999);

    if (bookingStart > maxDate) {
      return res.status(400).json({
        success: false,
        message: 'Bookings can only be made for today or tomorrow'
      });
    }

    // ✅ CREATE: Random Booking
    const booking = await RandomBooking.create({
      initiatorId: req.userId,
      city,
      lat,
      lng,
      activityType,
      locationCategory: locationCategory || 'Public Place',
      startTime: bookingStart,
      endTime: new Date(bookingStart.getTime() + 90 * 60000), // 90 minutes
      status: 'PENDING',
      createdAt: new Date(),
      expiresAt: bookingStart // Expires at start time if not matched
    });

    console.log('✅ Booking created:', booking._id);
    console.log('   Status: PENDING');
    console.log('   Location: ', lat, lng);

    // ✅ UPDATE: Mark trial as used
    user.random_trial_used = true;
    user.last_known_lat = lat;
    user.last_known_lng = lng;
    user.last_location_updated_at = new Date();
    await user.save();

    console.log('✅ User trial marked as used');

    // ✅ START: Progressive distance-based matching
    const { startProgressiveMatching } = require('../utils/progressiveMatching');
    startProgressiveMatching(booking._id);

    console.log('📡 Progressive matching initiated');
    console.log('='.repeat(60));
    console.log('');

    res.status(201).json({
      success: true,
      message: 'Random Meet request created! Looking for nearby matches...',
      booking: {
        _id: booking._id,
        city: booking.city,
        activityType: booking.activityType,
        startTime: booking.startTime,
        endTime: booking.endTime,
        status: booking.status
      }
    });
  } catch (error) {
    console.error('❌ Create booking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create booking'
    });
  }
});

// ==================== GET NEARBY BOOKINGS (GPS-BASED) ====================
router.get('/nearby', auth, async (req, res) => {
  try {
    console.log('');
    console.log('📍 GET NEARBY BOOKINGS');

    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        message: 'GPS coordinates required'
      });
    }

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);

    console.log('   User GPS:', userLat, userLng);

    // ✅ FIND: All PENDING bookings
    const allBookings = await RandomBooking.find({
      status: 'PENDING',
      initiatorId: { $ne: req.userId },
      expiresAt: { $gt: new Date() },
      startTime: { $gte: new Date() }
    })
    .populate('initiatorId', 'firstName lastName profilePhoto isVerified questionnaire')
    .lean();

    console.log(`   Found ${allBookings.length} pending bookings`);

    // ✅ FILTER: By distance (within 15km max)
    const nearbyBookings = allBookings
      .map(booking => {
        const distance = calculateDistance(
          userLat, userLng,
          booking.lat, booking.lng
        );
        return { ...booking, distance };
      })
      .filter(booking => booking.distance <= 15) // Max 15km
      .sort((a, b) => a.distance - b.distance)   // Closest first
      .slice(0, 10);                             // Max 10 results

    console.log(`   ${nearbyBookings.length} bookings within 15km`);

    // ✅ TRANSFORM: Remove exact GPS for privacy
    const safeBookings = nearbyBookings.map(booking => ({
      _id: booking._id,
      city: booking.city,
      activityType: booking.activityType,
      locationCategory: booking.locationCategory,
      startTime: booking.startTime,
      endTime: booking.endTime,
      distance: booking.distance.toFixed(1), // Rounded distance
      status: booking.status,
      createdAt: booking.createdAt,
      // DO NOT expose: initiatorId details, exact lat/lng
    }));

    res.json({
      success: true,
      bookings: safeBookings,
      userLocation: { lat: userLat, lng: userLng }
    });
  } catch (error) {
    console.error('❌ Get nearby bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load nearby bookings'
    });
  }
});

// ==================== ACCEPT BOOKING ====================
router.post('/:bookingId/accept', auth, async (req, res) => {
  try {
    console.log('');
    console.log('='.repeat(60));
    console.log('✅ ACCEPT BOOKING');
    console.log('='.repeat(60));

    const { lat, lng } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        message: 'Current GPS location required to accept booking'
      });
    }

    const user = await User.findById(req.userId).select('isVerified');

    // ✅ VALIDATION: User must be verified
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Only verified users can accept Random Meet requests'
      });
    }

    // ✅ FIND: Booking with atomic lock
    const booking = await RandomBooking.findOneAndUpdate(
      {
        _id: req.params.bookingId,
        status: 'PENDING',
        expiresAt: { $gt: new Date() }
      },
      {
        status: 'MATCHED',
        acceptorId: req.userId,
        matchedAt: new Date()
      },
      {
        new: true,
        runValidators: true
      }
    ).populate('initiatorId', 'firstName lastName profilePhoto');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found or no longer available'
      });
    }

    // ✅ VALIDATION: Cannot accept own booking
    if (booking.initiatorId._id.toString() === req.userId) {
      // Revert status
      booking.status = 'PENDING';
      booking.acceptorId = null;
      booking.matchedAt = null;
      await booking.save();

      return res.status(400).json({
        success: false,
        message: 'You cannot accept your own booking'
      });
    }

    // ✅ VALIDATION: Acceptor must be within reasonable distance
    const distance = calculateDistance(
      lat, lng,
      booking.lat, booking.lng
    );

    console.log('📍 Distance check:');
    console.log('   Booking at:', booking.lat, booking.lng);
    console.log('   Acceptor at:', lat, lng);
    console.log('   Distance:', distance.toFixed(2), 'km');

    if (distance > 20) { // Max 20km for acceptance
      // Revert status
      booking.status = 'PENDING';
      booking.acceptorId = null;
      booking.matchedAt = null;
      await booking.save();

      return res.status(400).json({
        success: false,
        message: 'You are too far from this booking location to accept it'
      });
    }

    console.log('✅ Distance validation passed');

    // ✅ UPDATE: User's last known location
    user.last_known_lat = lat;
    user.last_known_lng = lng;
    user.last_location_updated_at = new Date();
    await user.save();

    // ✅ CREATE: Booking Match record
    const match = await BookingMatch.create({
      bookingId: booking._id,
      initiatorId: booking.initiatorId._id,
      acceptorId: req.userId,
      matchedAt: new Date()
    });

    console.log('✅ BookingMatch created:', match._id);

    // ✅ CREATE: Chat
    const chat = await RandomBookingChat.createForBooking(booking);

    console.log('💬 Chat created:', chat._id);

    // ✅ UPDATE: Booking with chatId
    booking.chatId = chat._id;
    await booking.save();

    // ✅ NOTIFY: Both users
    const { notifyBookingMatched } = require('../utils/progressiveMatching');
    const acceptor = await User.findById(req.userId).select('firstName lastName profilePhoto');
    await notifyBookingMatched(booking, acceptor);

    console.log('📢 Notifications sent');
    console.log('='.repeat(60));
    console.log('');

    res.json({
      success: true,
      message: 'Booking accepted! Chat is now open.',
      chatId: chat._id.toString(),
      booking: {
        _id: booking._id,
        status: booking.status,
        startTime: booking.startTime,
        endTime: booking.endTime
      }
    });
  } catch (error) {
    console.error('❌ Accept booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to accept booking'
    });
  }
});

// ==================== CANCEL BOOKING ====================
router.post('/:bookingId/cancel', auth, async (req, res) => {
  try {
    console.log('❌ CANCEL BOOKING:', req.params.bookingId);

    const booking = await RandomBooking.findById(req.params.bookingId);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }
    
    // ✅ VALIDATION: Only initiator can cancel PENDING bookings
    if (booking.initiatorId.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Only the creator can cancel this booking'
      });
    }

    if (booking.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel a booking that has already been matched'
      });
    }
    
    // ✅ UPDATE: Set status to CANCELLED
    booking.status = 'CANCELLED';
    booking.cancelledAt = new Date();
    booking.cancellationReason = req.body.reason || 'User cancelled';
    await booking.save();

    console.log('✅ Booking cancelled');

    // ✅ INCREMENT: User's cancellation count (for silent throttling)
    await User.findByIdAndUpdate(req.userId, {
      $inc: { 'behaviorMetrics.cancellationCount': 1 }
    });
    
    res.json({
      success: true,
      message: 'Booking cancelled successfully'
    });
  } catch (error) {
    console.error('❌ Cancel booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel booking'
    });
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
      select: 'firstName lastName profilePhoto isVerified'
    })
    .populate({
      path: 'bookingId',
      select: 'city activityType locationCategory startTime endTime status'
    })
    .sort({ lastMessageAt: -1 });

    res.json({ success: true, chats });
  } catch (error) {
    console.error('❌ Get chats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load chats'
    });
  }
});

// ==================== GET MESSAGES ====================
router.get('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId)
      .populate('bookingId');
    
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }
    
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    const messages = await Message.find({
      chatId: req.params.chatId,
      isDeleted: false
    })
    .populate('senderId', 'firstName lastName profilePhoto')
    .sort({ timestamp: 1 })
    .limit(200);

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
      messageType: msg.messageType || 'TEXT',
      timestamp: msg.timestamp.toISOString(),
      isSystemMessage: msg.isSystemMessage || false,
      deliveryStatus: msg.deliveryStatus || 'SENT'
    }));
    
    res.json({
      success: true,
      chat: chat,
      messages: transformedMessages,
      expiresAt: chat.expiresAt,
      isExpired: chat.isExpired()
    });
  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load messages'
    });
  }
});

// ==================== SEND MESSAGE ====================
router.post('/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }
    
    if (!chat.isParticipant(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    if (chat.isExpired()) {
      return res.status(410).json({
        success: false,
        message: 'This chat has expired'
      });
    }

    if (!req.body.content || !req.body.content.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message content is required'
      });
    }
    
    const message = await Message.create({
      chatId: req.params.chatId,
      senderId: req.userId,
      senderRole: 'USER',
      content: req.body.content.trim(),
      messageType: req.body.messageType || 'TEXT',
      deliveryStatus: 'SENT'
    });
    
    await message.populate('senderId', 'firstName lastName profilePhoto');
    
    chat.lastMessageAt = new Date();
    await chat.save();
    
    // Socket.IO emit
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
        isSystemMessage: false,
        deliveryStatus: 'SENT'
      };
      
      io.to(req.params.chatId).emit('new-message', messageData);
    }
    
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
    console.error('❌ Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message'
    });
  }
});

// ==================== REPORT USER ====================
router.post('/chats/:chatId/report', auth, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    
    if (!chat || !chat.isParticipant(req.userId) || chat.isDeleted) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found or access denied'
      });
    }

    const { category, description } = req.body;

    if (!category || !description) {
      return res.status(400).json({
        success: false,
        message: 'Category and description are required'
      });
    }

    const otherParticipant = chat.participants.find(p =>
      p.userId.toString() !== req.userId
    );

    if (!otherParticipant) {
      return res.status(400).json({
        success: false,
        message: 'Other user not found'
      });
    }

    const SafetyReport = require('../models/SafetyReport');
    const report = await SafetyReport.create({
      reporterId: req.userId,
      reportedUserId: otherParticipant.userId,
      category,
      description,
      relatedBookingId: chat.bookingId,
      priority: 'HIGH',
      status: 'PENDING'
    });

    await chat.flagForReview(report._id);

    res.json({
      success: true,
      message: 'Report submitted successfully',
      reportId: report._id
    });
  } catch (error) {
    console.error('❌ Report user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit report'
    });
  }
});

// ==================== CHECK TRIAL STATUS ====================
router.get('/trial-status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('random_trial_used isVerified');

    res.json({
      success: true,
      trialUsed: user.random_trial_used || false,
      isVerified: user.isVerified || false,
      canCreateBooking: user.isVerified && !user.random_trial_used
    });
  } catch (error) {
    console.error('❌ Check trial status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check trial status'
    });
  }
});

module.exports = router;
