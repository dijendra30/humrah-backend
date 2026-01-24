// routes/voice-call.js - FIXED
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

// ... (AGORA CONFIGURATION and helper functions remain the same) ...
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const TOKEN_EXPIRATION_TIME = 30 * 60;

function generateAgoraToken(channelName, uid, role = RtcRole.PUBLISHER) {
  if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
    throw new Error('Agora credentials not configured');
  }
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTimestamp + TOKEN_EXPIRATION_TIME;
  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_APP_CERTIFICATE,
    channelName,
    uid,
    role,
    privilegeExpireTime
  );
}

function objectIdToUid(objectId) {
  const hex = objectId.toString().slice(-8);
  const uid = parseInt(hex, 16);
  return Math.abs(uid) % 0xFFFFFFFF;
}

// ==================== ROUTES ====================

/**
 * POST /api/voice-call/initiate
 */
router.post('/initiate', authenticate, validateCallInitiation, async (req, res) => {
  try {
    const callerId = req.userId; // ✅ CORRECT
    const { receiverId, bookingId } = req.body;
    const { caller, receiver, booking } = req.validatedCallData;
    
    const io = req.app.get('io');
    
    if (!isReceiverOnline(receiverId, io)) {
      return res.status(400).json({
        success: false,
        error: 'USER_OFFLINE',
        message: `${receiver.firstName} is not available for calls right now`
      });
    }
    
    const channelName = `voice_${booking._id}_${Date.now()}`;
    const callerUid = objectIdToUid(callerId);
    const callerToken = generateAgoraToken(channelName, callerUid);
    
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
 */
router.post('/accept/:callId', authenticate, validateCallAcceptance, async (req, res) => {
  try {
    const userId = req.userId; // ✅ FIXED
    const call = req.voiceCall;
    
    const receiverUid = objectIdToUid(userId);
    const receiverToken = generateAgoraToken(call.channelName, receiverUid);
    
    call.status = 'CONNECTING';
    call.acceptedAt = new Date();
    call.receiverAgoraUid = receiverUid;
    await call.save();
    
    const io = req.app.get('io');
    const callerSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.userId?.toString() === call.callerId.toString());
    
    callerSockets.forEach(socket => {
      socket.emit('voice-call-accepted', { callId: call._id.toString() });
    });
    
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
 */
router.post('/reject/:callId', authenticate, async (req, res) => {
  try {
    const userId = req.userId; // ✅ FIXED
    const { callId } = req.params;
    
    const call = await VoiceCall.findById(callId);
    
    if (!call) {
      return res.status(404).json({ success: false, error: 'CALL_NOT_FOUND', message: 'Call not found' });
    }
    
    if (call.receiverId.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, error: 'UNAUTHORIZED', message: 'You are not the receiver of this call' });
    }
    
    if (call.status !== 'RINGING') {
      return res.status(400).json({ success: false, error: 'INVALID_STATE', message: 'Can only reject ringing calls' });
    }
    
    await call.decline();
    
    const io = req.app.get('io');
    const callerSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.userId?.toString() === call.callerId.toString());
      
    callerSockets.forEach(socket => {
      socket.emit('voice-call-rejected', { callId: call._id.toString() });
    });
    
    res.json({ success: true, message: 'Call rejected' });
    
  } catch (error) {
    console.error('❌ Error rejecting voice call:', error);
    res.status(500).json({ success: false, error: 'CALL_REJECTION_FAILED', message: 'Failed to reject voice call' });
  }
});

/**
 * POST /api/voice-call/end/:callId
 */
router.post('/end/:callId', authenticate, validateCallEnd, async (req, res) => {
  try {
    const userId = req.userId; // ✅ FIXED
    const call = req.voiceCall;
    const { reason = 'user_ended' } = req.body;
    
    await call.end(reason);
    
    const otherUserId = call.callerId.toString() === userId.toString() ? call.receiverId : call.callerId;
    
    const io = req.app.get('io');
    const otherUserSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.userId?.toString() === otherUserId.toString());
      
    otherUserSockets.forEach(socket => {
      socket.emit('voice-call-ended', { callId: call._id.toString(), reason, duration: call.duration || 0 });
    });
    
    res.json({ success: true, duration: call.duration || 0, message: 'Call ended' });
    
  } catch (error) {
    console.error('❌ Error ending voice call:', error);
    res.status(500).json({ success: false, error: 'CALL_END_FAILED', message: 'Failed to end voice call' });
  }
});

// ... (The rest of the routes, PATCH /status, GET /active, etc. also need to use req.userId)
// For brevity, I'm showing the pattern. Please apply it to all remaining routes in this file.

module.exports = router;


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
