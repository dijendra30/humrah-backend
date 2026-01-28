// middleware/voice-call-validator.js - PRODUCTION VERSION
// ✅ NO CALL LIMITS - Users can call anytime until chat expires
// ✅ Calls auto-end after 30 minutes
const RandomBooking = require('../models/RandomBooking');
const VoiceCall = require('../models/VoiceCall');
const User = require('../models/User');
const RandomBookingChat = require('../models/RandomBookingChat');

/**
 * ✅ Validate if a voice call can be initiated
 */
async function validateCallEligibility(callerId, receiverId, bookingId) {
  const errors = [];
  
  // ==================== 1. FETCH REQUIRED DATA ====================
  const [caller, receiver, booking, chat] = await Promise.all([
    User.findById(callerId),
    User.findById(receiverId),
    RandomBooking.findById(bookingId),
    RandomBookingChat.findOne({ bookingId, isDeleted: false })
  ]);
  
  // ==================== 2. VALIDATE EXISTENCE ====================
  if (!caller) {
    errors.push({ code: 'CALLER_NOT_FOUND', message: 'Caller not found' });
  }
  
  if (!receiver) {
    errors.push({ code: 'RECEIVER_NOT_FOUND', message: 'Receiver not found' });
  }
  
  if (!booking) {
    errors.push({ code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
  }
  
  if (!chat) {
    errors.push({ code: 'CHAT_NOT_FOUND', message: 'Chat not found for this booking' });
  }
  
  if (errors.length > 0) {
    return { valid: false, errors, data: null };
  }
  
  // ==================== 3. VALIDATE CHAT NOT EXPIRED ====================
  // ✅ CRITICAL: Check if chat is expired
  if (chat.isExpired()) {
    errors.push({
      code: 'CHAT_EXPIRED',
      message: 'This chat has expired. Voice calls are no longer available.'
    });
  }
  
  // ==================== 4. VALIDATE BOOKING STATUS ====================
  if (booking.status !== 'MATCHED') {
    errors.push({
      code: 'BOOKING_NOT_ACCEPTED',
      message: 'Voice calls are only available for accepted bookings'
    });
  }
  
  // ==================== 5. VALIDATE PARTICIPANTS ====================
  const isCallerParticipant = 
    booking.initiatorId.toString() === callerId.toString() ||
    booking.acceptedUserId?.toString() === callerId.toString();
  
  const isReceiverParticipant =
    booking.initiatorId.toString() === receiverId.toString() ||
    booking.acceptedUserId?.toString() === receiverId.toString();
  
  if (!isCallerParticipant) {
    errors.push({
      code: 'CALLER_NOT_PARTICIPANT',
      message: 'Caller is not a participant in this booking'
    });
  }
  
  if (!isReceiverParticipant) {
    errors.push({
      code: 'RECEIVER_NOT_PARTICIPANT',
      message: 'Receiver is not a participant in this booking'
    });
  }
  
  // ==================== 6. VALIDATE USERS ACTIVE ====================
  if (caller.status !== 'ACTIVE') {
    errors.push({
      code: 'CALLER_INACTIVE',
      message: 'Caller account is not active'
    });
  }
  
  if (receiver.status !== 'ACTIVE') {
    errors.push({
      code: 'RECEIVER_INACTIVE',
      message: 'Receiver account is not active'
    });
  }
  
  // ==================== 7. VALIDATE NOT BLOCKED ====================
  const callerBlocked = caller.blockedUsers?.includes(receiverId);
  const receiverBlocked = receiver.blockedUsers?.includes(callerId);
  
  if (callerBlocked || receiverBlocked) {
    errors.push({
      code: 'USER_BLOCKED',
      message: 'Cannot call this user'
    });
  }
  // In your voice-call validation middleware:
  // ==================== 8. VALIDATE RECEIVER NOT ON ANOTHER CALL ====================
  const receiverOnCall = await VoiceCall.isUserOnCall(receiverId);
  
  if (receiverOnCall) {
    errors.push({
      code: 'RECEIVER_BUSY',
      message: 'User is currently on another call'
    });
  }
  
  // ==================== 9. VALIDATE CALLER NOT ON ANOTHER CALL ====================
  const callerOnCall = await VoiceCall.isUserOnCall(callerId);
  
  if (callerOnCall) {
    errors.push({
      code: 'CALLER_BUSY',
      message: 'You are already on a call'
    });
  }
  
  // ==================== NO RATE LIMITING ✅ ====================
  // Users can call as many times as they want until chat expires
  
  // ==================== RETURN RESULT ====================
  if (errors.length > 0) {
    return { valid: false, errors, data: { caller, receiver, booking, chat } };
  }
  
  return {
    valid: true,
    errors: [],
    data: {
      caller,
      receiver,
      booking,
      chat
    }
  };
}

/**
 * Middleware to validate call initiation
 */
async function validateCallInitiation(req, res, next) {
  try {
    const callerId = req.userId;
    const { receiverId, bookingId } = req.body;
    
    console.log('=================================');
    console.log('📞 CALL VALIDATION');
    console.log('=================================');
    console.log('Caller ID:', callerId.toString());
    console.log('Receiver ID:', receiverId.toString());
    console.log('Booking ID:', bookingId.toString());
    
    // Validate request body
    if (!receiverId || !bookingId) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'receiverId and bookingId are required'
      });
    }
    
    // ✅ Self-call check
    if (callerId.toString() === receiverId.toString()) {
      return res.status(400).json({
        success: false,
        error: 'SELF_CALL_NOT_ALLOWED',
        message: 'You cannot start a voice call with yourself.'
      });
    }
    
    // Validate eligibility
    const validation = await validateCallEligibility(callerId, receiverId, bookingId);
    
    if (!validation.valid) {
      const error = validation.errors[0];
      
      console.log('❌ VALIDATION FAILED:');
      validation.errors.forEach(err => {
        console.log(`   - ${err.code}: ${err.message}`);
      });
      
      // Special handling for CHAT_EXPIRED
      if (error.code === 'CHAT_EXPIRED') {
        console.log('⏰ Chat has expired - voice calls no longer available');
      }
      
      return res.status(400).json({
        success: false,
        error: error.code,
        message: error.message,
        allErrors: validation.errors
      });
    }
    
    // Attach validated data to request
    req.validatedCallData = validation.data;
    
    console.log('✅ Validation passed - call allowed');
    console.log('=================================');
    
    next();
  } catch (error) {
    console.error('Call validation error:', error);
    res.status(500).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Failed to validate call eligibility'
    });
  }
}

/**
 * Middleware to validate call end
 */
async function validateCallEnd(req, res, next) {
  try {
    const userId = req.userId;
    const { callId } = req.params;
    
    const call = await VoiceCall.findById(callId);
    
    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'CALL_NOT_FOUND',
        message: 'Call not found'
      });
    }
    
    // Validate user is participant
    const isParticipant = 
      call.callerId.toString() === userId.toString() ||
      call.receiverId.toString() === userId.toString();
    
    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'You are not a participant in this call'
      });
    }
    
    // Validate call is active
    if (!call.isActive) {
      return res.status(400).json({
        success: false,
        error: 'CALL_NOT_ACTIVE',
        message: 'This call is not active'
      });
    }
    
    // Attach call to request
    req.voiceCall = call;
    
    next();
  } catch (error) {
    console.error('Call end validation error:', error);
    res.status(500).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Failed to validate call end'
    });
  }
}

module.exports = {
  validateCallEligibility,
  validateCallInitiation,
  validateCallEnd
};
