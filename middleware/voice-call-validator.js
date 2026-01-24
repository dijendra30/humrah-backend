// middleware/voice-call-validator.js - Call Eligibility Validation
const RandomBooking = require('../models/RandomBooking');
const VoiceCall = require('../models/VoiceCall');
const User = require('../models/User');

/**
 * Validate if a voice call can be initiated
 */
async function validateCallEligibility(callerId, receiverId, bookingId) {
  const errors = [];
  
  // ==================== 1. FETCH REQUIRED DATA ====================
  const [caller, receiver, booking] = await Promise.all([
    User.findById(callerId),
    User.findById(receiverId),
    RandomBooking.findById(bookingId)
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
  
  if (errors.length > 0) {
    return { valid: false, errors, data: null };
  }
  
  // ==================== 3. VALIDATE BOOKING STATUS ====================
  if (booking.status !== 'MATCHED') {
    errors.push({
      code: 'BOOKING_NOT_ACCEPTED',
      message: 'Voice calls are only available for accepted bookings'
    });
  }
  
  // ==================== 4. VALIDATE BOOKING NOT EXPIRED ====================
  const meetupDate = new Date(booking.date);
  meetupDate.setHours(23, 59, 59, 999); // End of meetup day
  
  if (new Date() > meetupDate) {
    errors.push({
      code: 'BOOKING_EXPIRED',
      message: 'This booking has ended. Voice calls are no longer available.'
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
  if (!caller.isActive) {
    errors.push({
      code: 'CALLER_INACTIVE',
      message: 'Caller account is inactive'
    });
  }
  
  if (!receiver.isActive) {
    errors.push({
      code: 'RECEIVER_INACTIVE',
      message: 'Receiver account is inactive'
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
  
  // ==================== 10. RATE LIMITING ====================
  const recentAttempts = await VoiceCall.countRecentAttempts(callerId, bookingId, 1);
  
  if (recentAttempts >= 3) {
    errors.push({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many call attempts. Please wait before trying again.'
    });
  }
  
  // ==================== RETURN RESULT ====================
  if (errors.length > 0) {
    return { valid: false, errors, data: null };
  }
  
  return {
    valid: true,
    errors: [],
    data: {
      caller,
      receiver,
      booking
    }
  };
}

/**
 * Middleware to validate call initiation
 */
async function validateCallInitiation(req, res, next) {
  try {
    const callerId = req.userId; // From auth middleware
    const { receiverId, bookingId } = req.body;
    
    // Validate request body
    if (!receiverId || !bookingId) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'receiverId and bookingId are required'
      });
    }
    
    // Validate eligibility
    const validation = await validateCallEligibility(callerId, receiverId, bookingId);
    
    if (!validation.valid) {
      // Return first error
      const error = validation.errors[0];
      return res.status(400).json({
        success: false,
        error: error.code,
        message: error.message,
        allErrors: validation.errors
      });
    }
    
    // Attach validated data to request
    req.validatedCallData = validation.data;
    
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
 * Middleware to validate call acceptance
 */
async function validateCallAcceptance(req, res, next) {
  try {
    const userId = req.userId; // ✅ FIXED
    const { callId } = req.params;
    
    // Fetch call
    const call = await VoiceCall.findById(callId);
    
    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'CALL_NOT_FOUND',
        message: 'Call not found'
      });
    }
    
    // Validate user is receiver
    if (call.receiverId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'You are not the receiver of this call'
      });
    }
    
    // Validate call can be accepted
    if (!call.canBeAccepted()) {
      return res.status(400).json({
        success: false,
        error: 'CALL_CANNOT_BE_ACCEPTED',
        message: 'This call can no longer be accepted'
      });
    }
    
    // Attach call to request
    req.voiceCall = call;
    
    next();
  } catch (error) {
    console.error('Call acceptance validation error:', error);
    res.status(500).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Failed to validate call acceptance'
    });
  }
}

/**
 * Middleware to validate call end
 */
async function validateCallEnd(req, res, next) {
  try {
    const userId = req.userId; // ✅ FIXED
    const { callId } = req.params;
    
    // Fetch call
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

/**
 * Helper: Check if receiver is online (has active socket connection)
 */
function isReceiverOnline(receiverId, io) {
  // Get all connected sockets
  const sockets = io.sockets.sockets;
  
  // Check if any socket belongs to receiver
  for (const [socketId, socket] of sockets) {
    if (socket.userId?.toString() === receiverId.toString()) {
      return true;
    }
  }
  
  return false;
}

module.exports = {
  validateCallEligibility,
  validateCallInitiation,
  validateCallAcceptance,
  validateCallEnd,
  isReceiverOnline
};
