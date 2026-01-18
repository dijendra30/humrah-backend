// routes/voice-call.js - Voice Call API Routes
const express = require('express');
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const crypto = require('crypto');
const VoiceCall = require('../models/VoiceCall');
const User = require('../models/User');
const {
  validateCallInitiation,
  validateCallAcceptance,
  validateCallEnd,
  isReceiverOnline
} = require('../middleware/voice-call-validator');
const { authenticate } = require('../middleware/auth');

// ==================== AGORA CONFIGURATION ====================
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// Token expiration time (30 minutes)
const TOKEN_EXPIRATION_TIME = 30 * 60; // seconds

/**
 * Generate Agora RTC token
 */
function generateAgoraToken(channelName, uid, role = RtcRole.PUBLISHER) {
  if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
    throw new Error('Agora credentials not configured');
  }
  
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTimestamp + TOKEN_EXPIRATION_TIME;
  
  const token = RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_APP_CERTIFICATE,
    channelName,
    uid,
    role,
    privilegeExpireTime
  );
  
  return token;
}

/**
 * Convert MongoDB ObjectId to numeric UID for Agora
 * Agora requires 32-bit unsigned integer
 */
function objectIdToUid(objectId) {
  // Get last 8 characters of ObjectId and convert to integer
  const hex = objectId.toString().slice(-8);
  const uid = parseInt(hex, 16);
  
  // Ensure it's a positive 32-bit integer
  return Math.abs(uid) % 0xFFFFFFFF;
}

// ==================== ROUTES ====================

/**
 * POST /api/voice-call/initiate
 * Initiate a voice call
 */
router.post('/initiate', authenticate, validateCallInitiation, async (req, res) => {
  try {
    const callerId = req.user.userId;
    const { receiverId, bookingId } = req.body;
    const { caller, receiver, booking } = req.validatedCallData;
    
    // Get Socket.IO instance
    const io = req.app.get('io');
    
    // Check if receiver is online
    if (!isReceiverOnline(receiverId, io)) {
      return res.status(400).json({
        success: false,
        error: 'USER_OFFLINE',
        message: `${receiver.firstName} is not available for calls right now`
      });
    }
    
    // Generate unique channel name
    const channelName = `voice_${booking._id}_${Date.now()}`;
    
    // Generate numeric UID for caller
    const callerUid = objectIdToUid(callerId);
    
    // Generate Agora token for caller
    const callerToken = generateAgoraToken(channelName, callerUid, RtcRole.PUBLISHER);
    
    // Create VoiceCall document
    const voiceCall = new VoiceCall({
      callerId,
      receiverId,
      bookingId,
      channelName,
      callerAgoraUid: callerUid,
      status: 'RINGING',
      initiatedAt: new Date()
    });
    
    await voiceCall.save();
    
    console.log(`📞 Voice call initiated: ${voiceCall._id}`);
    console.log(`   Caller: ${caller.firstName} ${caller.lastName} (${callerId})`);
    console.log(`   Receiver: ${receiver.firstName} ${receiver.lastName} (${receiverId})`);
    console.log(`   Booking: ${bookingId}`);
    console.log(`   Channel: ${channelName}`);
    
    // Emit socket event to receiver
    const receiverSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.userId?.toString() === receiverId.toString());
    
    receiverSockets.forEach(socket => {
      socket.emit('incoming-voice-call', {
        callId: voiceCall._id.toString(),
        caller: {
          _id: caller._id,
          firstName: caller.firstName,
          lastName: caller.lastName,
          profilePhoto: caller.profilePhoto,
          fullName: `${caller.firstName} ${caller.lastName || ''}`.trim()
        },
        bookingId: booking._id,
        channelName
      });
    });
    
    console.log(`   ✅ Socket event emitted to ${receiverSockets.length} receiver socket(s)`);
    
    // Return token and call details to caller
    res.status(201).json({
      success: true,
      callId: voiceCall._id,
      token: callerToken,
      channelName,
      uid: callerUid,
      appId: AGORA_APP_ID,
      receiver: {
        _id: receiver._id,
        firstName: receiver.firstName,
        lastName: receiver.lastName,
        profilePhoto: receiver.profilePhoto
      }
    });
    
  } catch (error) {
    console.error('❌ Error initiating voice call:', error);
    res.status(500).json({
      success: false,
      error: 'CALL_INITIATION_FAILED',
      message: 'Failed to initiate voice call'
    });
  }
});

/**
 * POST /api/voice-call/accept/:callId
 * Accept an incoming voice call
 */
router.post('/accept/:callId', authenticate, validateCallAcceptance, async (req, res) => {
  try {
    const userId = req.user.userId;
    const call = req.voiceCall;
    
    // Generate numeric UID for receiver
    const receiverUid = objectIdToUid(userId);
    
    // Generate Agora token for receiver
    const receiverToken = generateAgoraToken(
      call.channelName,
      receiverUid,
      RtcRole.PUBLISHER
    );
    
    // Update call status
    call.status = 'CONNECTING';
    call.acceptedAt = new Date();
    call.receiverAgoraUid = receiverUid;
    await call.save();
    
    console.log(`✅ Voice call accepted: ${call._id}`);
    console.log(`   Receiver: ${userId}`);
    console.log(`   Receiver UID: ${receiverUid}`);
    
    // Emit socket event to caller
    const io = req.app.get('io');
    const callerSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.userId?.toString() === call.callerId.toString());
    
    callerSockets.forEach(socket => {
      socket.emit('voice-call-accepted', {
        callId: call._id.toString()
      });
    });
    
    console.log(`   ✅ Socket event emitted to ${callerSockets.length} caller socket(s)`);
    
    // Return token and channel details to receiver
    res.json({
      success: true,
      token: receiverToken,
      channelName: call.channelName,
      uid: receiverUid,
      appId: AGORA_APP_ID
    });
    
  } catch (error) {
    console.error('❌ Error accepting voice call:', error);
    res.status(500).json({
      success: false,
      error: 'CALL_ACCEPTANCE_FAILED',
      message: 'Failed to accept voice call'
    });
  }
});

/**
 * POST /api/voice-call/reject/:callId
 * Reject an incoming voice call
 */
router.post('/reject/:callId', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
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
    
    // Validate call is ringing
    if (call.status !== 'RINGING') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_STATE',
        message: 'Can only reject ringing calls'
      });
    }
    
    // Decline the call
    await call.decline();
    
    console.log(`❌ Voice call rejected: ${call._id}`);
    
    // Emit socket event to caller
    const io = req.app.get('io');
    const callerSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.userId?.toString() === call.callerId.toString());
    
    callerSockets.forEach(socket => {
      socket.emit('voice-call-rejected', {
        callId: call._id.toString()
      });
    });
    
    res.json({
      success: true,
      message: 'Call rejected'
    });
    
  } catch (error) {
    console.error('❌ Error rejecting voice call:', error);
    res.status(500).json({
      success: false,
      error: 'CALL_REJECTION_FAILED',
      message: 'Failed to reject voice call'
    });
  }
});

/**
 * POST /api/voice-call/end/:callId
 * End an active voice call
 */
router.post('/end/:callId', authenticate, validateCallEnd, async (req, res) => {
  try {
    const userId = req.user.userId;
    const call = req.voiceCall;
    const { reason = 'user_ended' } = req.body;
    
    // End the call
    await call.end(reason);
    
    console.log(`📵 Voice call ended: ${call._id}`);
    console.log(`   Duration: ${call.duration || 0} seconds`);
    console.log(`   Reason: ${reason}`);
    
    // Determine other user
    const otherUserId = 
      call.callerId.toString() === userId.toString()
        ? call.receiverId
        : call.callerId;
    
    // Emit socket event to other user
    const io = req.app.get('io');
    const otherUserSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.userId?.toString() === otherUserId.toString());
    
    otherUserSockets.forEach(socket => {
      socket.emit('voice-call-ended', {
        callId: call._id.toString(),
        reason,
        duration: call.duration || 0
      });
    });
    
    res.json({
      success: true,
      duration: call.duration || 0,
      message: 'Call ended'
    });
    
  } catch (error) {
    console.error('❌ Error ending voice call:', error);
    res.status(500).json({
      success: false,
      error: 'CALL_END_FAILED',
      message: 'Failed to end voice call'
    });
  }
});

/**
 * PATCH /api/voice-call/status/:callId
 * Update call status (used when call connects)
 */
router.patch('/status/:callId', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { callId } = req.params;
    const { status } = req.body;
    
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
    
    // Update status to CONNECTED
    if (status === 'CONNECTED' && call.status === 'CONNECTING') {
      call.status = 'CONNECTED';
      call.connectedAt = new Date();
      await call.save();
      
      console.log(`✅ Voice call connected: ${call._id}`);
    }
    
    res.json({
      success: true,
      status: call.status
    });
    
  } catch (error) {
    console.error('❌ Error updating call status:', error);
    res.status(500).json({
      success: false,
      error: 'STATUS_UPDATE_FAILED',
      message: 'Failed to update call status'
    });
  }
});

/**
 * GET /api/voice-call/active
 * Get user's active call (if any)
 */
router.get('/active', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const activeCall = await VoiceCall.getUserActiveCall(userId);
    
    if (!activeCall) {
      return res.json({
        success: true,
        hasActiveCall: false,
        call: null
      });
    }
    
    // Determine if user is caller or receiver
    const isCaller = activeCall.callerId.toString() === userId.toString();
    
    // Populate other user info
    const otherUserId = isCaller ? activeCall.receiverId : activeCall.callerId;
    const otherUser = await User.findById(otherUserId)
      .select('firstName lastName profilePhoto');
    
    res.json({
      success: true,
      hasActiveCall: true,
      call: {
        callId: activeCall._id,
        status: activeCall.status,
        isCaller,
        otherUser: {
          _id: otherUser._id,
          firstName: otherUser.firstName,
          lastName: otherUser.lastName,
          profilePhoto: otherUser.profilePhoto
        },
        channelName: activeCall.channelName,
        initiatedAt: activeCall.initiatedAt
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting active call:', error);
    res.status(500).json({
      success: false,
      error: 'GET_ACTIVE_CALL_FAILED',
      message: 'Failed to get active call'
    });
  }
});

/**
 * GET /api/voice-call/booking/:bookingId/stats
 * Get call statistics for a booking
 */
router.get('/booking/:bookingId/stats', authenticate, async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const stats = await VoiceCall.getBookingCallStats(bookingId);
    
    res.json({
      success: true,
      stats
    });
    
  } catch (error) {
    console.error('❌ Error getting call stats:', error);
    res.status(500).json({
      success: false,
      error: 'GET_STATS_FAILED',
      message: 'Failed to get call statistics'
    });
  }
});

module.exports = router;
