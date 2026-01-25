// routes/voice-call.js - COMPLETE FIXED VERSION WITH FCM
const express = require('express');
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const VoiceCall = require('../models/VoiceCall');
const User = require('../models/User');
const admin = require('../config/firebase'); // ✅ Import Firebase Admin
const {
  validateCallInitiation,
  validateCallAcceptance,
  validateCallEnd
} = require('../middleware/voice-call-validator');
const { authenticate } = require('../middleware/auth');

// ==================== AGORA CONFIGURATION ====================
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const TOKEN_EXPIRATION_TIME = 30 * 60; // 30 minutes

/**
 * Generate Agora RTC Token
 */
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

/**
 * Convert MongoDB ObjectId to numeric UID for Agora
 */
function objectIdToUid(objectId) {
  const hex = objectId.toString().slice(-8);
  const uid = parseInt(hex, 16);
  return Math.abs(uid) % 0xFFFFFFFF;
}

/**
 * Check if receiver is online (has active socket connection)
 */
function isReceiverOnline(receiverId, io) {
  if (!io) return false;
  
  const sockets = io.sockets.sockets;
  
  for (const [socketId, socket] of sockets) {
    if (socket.userId?.toString() === receiverId.toString()) {
      return true;
    }
  }
  
  return false;
}

// ==================== ROUTES ====================

/**
 * POST /api/voice-call/initiate
 * ✅ FIXED: Sends FCM notification + socket event
 */
router.post('/initiate', authenticate, validateCallInitiation, async (req, res) => {
  try {
    const callerId = req.userId;
    const { receiverId, bookingId } = req.body;
    const { caller, receiver, booking } = req.validatedCallData;
    
    console.log('📞 Initiating call:', {
      callerId: callerId.toString(),
      receiverId: receiverId.toString(),
      bookingId: bookingId.toString()
    });
    
    // ✅ Generate Agora credentials
    const channelName = `voice_${booking._id}_${Date.now()}`;
    const callerUid = objectIdToUid(callerId);
    const callerToken = generateAgoraToken(channelName, callerUid);
    
    console.log('🔐 Agora credentials generated:', {
      channelName,
      callerUid,
      appId: AGORA_APP_ID
    });
    
    // ✅ Create voice call record
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
    
    console.log('✅ Voice call record created:', voiceCall._id);
    
    // ✅ CRITICAL: Send FCM notification to receiver
    try {
      if (receiver.fcmTokens && receiver.fcmTokens.length > 0) {
        console.log(`📨 Sending FCM to ${receiver.fcmTokens.length} token(s)`);
        
        const fcmMessage = {
          notification: {
            title: '📞 Incoming Call',
            body: `${caller.firstName} ${caller.lastName} is calling...`
          },
          data: {
            type: 'INCOMING_CALL',
            callId: voiceCall._id.toString(),
            bookingId: bookingId.toString(),
            callerId: callerId.toString(),
            callerName: `${caller.firstName} ${caller.lastName}`,
            callerPhoto: caller.profilePhoto || '',
            channelName: channelName,
            token: callerToken, // ✅ Send token so receiver can join immediately
            uid: callerUid.toString(),
            appId: AGORA_APP_ID
          },
          tokens: receiver.fcmTokens,
          android: {
            priority: 'high',
            notification: {
              channelId: 'incoming_calls',
              priority: 'max',
              defaultSound: true,
              defaultVibrateTimings: true,
              visibility: 'public'
            }
          }
        };
        
        const fcmResponse = await admin.messaging().sendEachForMulticast(fcmMessage);
        
        console.log(`✅ FCM sent: ${fcmResponse.successCount}/${receiver.fcmTokens.length} successful`);
        
        if (fcmResponse.failureCount > 0) {
          console.log(`⚠️ FCM failures: ${fcmResponse.failureCount}`);
          
          // Remove invalid tokens
          const failedTokens = [];
          fcmResponse.responses.forEach((resp, idx) => {
            if (!resp.success) {
              failedTokens.push(receiver.fcmTokens[idx]);
              console.log(`   Token ${idx}: ${resp.error?.code}`);
            }
          });
          
          if (failedTokens.length > 0) {
            await User.findByIdAndUpdate(receiverId, {
              $pull: { fcmTokens: { $in: failedTokens } }
            });
            console.log(`🧹 Removed ${failedTokens.length} invalid tokens`);
          }
        }
      } else {
        console.log('⚠️ Receiver has no FCM tokens');
      }
    } catch (fcmError) {
      console.error('❌ FCM send error:', fcmError);
      // Don't fail the call, just log the error
    }
    
    // ✅ Also emit socket event (for when app is open)
    const io = req.app.get('io');
    if (io) {
      const receiverSockets = Array.from(io.sockets.sockets.values())
        .filter(s => s.userId?.toString() === receiverId.toString());
      
      if (receiverSockets.length > 0) {
        receiverSockets.forEach(socket => {
          socket.emit('incoming-voice-call', {
            callId: voiceCall._id.toString(),
            caller: {
              _id: caller._id,
              firstName: caller.firstName,
              lastName: caller.lastName,
              profilePhoto: caller.profilePhoto,
              fullName: `${caller.firstName} ${caller.lastName}`.trim()
            },
            bookingId: booking._id,
            channelName
          });
        });
        console.log(`✅ Socket event sent to ${receiverSockets.length} socket(s)`);
      } else {
        console.log('⚠️ Receiver not connected via socket (app might be closed)');
      }
    }
    
    // ✅ Return success to caller
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
 * ✅ FIXED: Sends FCM to caller + socket event
 */
router.post('/accept/:callId', authenticate, validateCallAcceptance, async (req, res) => {
  try {
    const userId = req.userId;
    const call = req.voiceCall;
    
    console.log('✅ Accepting call:', call._id);
    
    // Generate token for receiver
    const receiverUid = objectIdToUid(userId);
    const receiverToken = generateAgoraToken(call.channelName, receiverUid);
    
    // Update call status
    call.status = 'CONNECTING';
    call.acceptedAt = new Date();
    call.receiverAgoraUid = receiverUid;
    await call.save();
    
    console.log('✅ Call status updated to CONNECTING');
    
    // ✅ Send FCM to caller
    try {
      const caller = await User.findById(call.callerId).select('fcmTokens firstName lastName');
      
      if (caller && caller.fcmTokens && caller.fcmTokens.length > 0) {
        const fcmMessage = {
          data: {
            type: 'CALL_ACCEPTED',
            callId: call._id.toString()
          },
          tokens: caller.fcmTokens
        };
        
        await admin.messaging().sendEachForMulticast(fcmMessage);
        console.log('✅ FCM sent to caller (call accepted)');
      }
    } catch (fcmError) {
      console.error('❌ FCM error:', fcmError);
    }
    
    // ✅ Emit socket event
    const io = req.app.get('io');
    if (io) {
      const callerSockets = Array.from(io.sockets.sockets.values())
        .filter(s => s.userId?.toString() === call.callerId.toString());
      
      callerSockets.forEach(socket => {
        socket.emit('voice-call-accepted', { 
          callId: call._id.toString() 
        });
      });
      
      console.log(`✅ Socket event sent to ${callerSockets.length} caller socket(s)`);
    }
    
    // Return credentials to receiver
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
 * ✅ FIXED: Sends FCM to caller + socket event
 */
router.post('/reject/:callId', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const { callId } = req.params;
    
    const call = await VoiceCall.findById(callId);
    
    if (!call) {
      return res.status(404).json({ 
        success: false, 
        error: 'CALL_NOT_FOUND' 
      });
    }
    
    if (call.receiverId.toString() !== userId.toString()) {
      return res.status(403).json({ 
        success: false, 
        error: 'UNAUTHORIZED' 
      });
    }
    
    if (call.status !== 'RINGING') {
      return res.status(400).json({ 
        success: false, 
        error: 'INVALID_STATE' 
      });
    }
    
    await call.decline();
    
    console.log('❌ Call rejected:', callId);
    
    // ✅ Send FCM to caller
    try {
      const caller = await User.findById(call.callerId).select('fcmTokens');
      
      if (caller && caller.fcmTokens && caller.fcmTokens.length > 0) {
        const fcmMessage = {
          data: {
            type: 'CALL_REJECTED',
            callId: call._id.toString(),
            reason: 'User declined the call'
          },
          tokens: caller.fcmTokens
        };
        
        await admin.messaging().sendEachForMulticast(fcmMessage);
        console.log('✅ FCM sent to caller (call rejected)');
      }
    } catch (fcmError) {
      console.error('❌ FCM error:', fcmError);
    }
    
    // ✅ Emit socket event
    const io = req.app.get('io');
    if (io) {
      const callerSockets = Array.from(io.sockets.sockets.values())
        .filter(s => s.userId?.toString() === call.callerId.toString());
        
      callerSockets.forEach(socket => {
        socket.emit('voice-call-rejected', { 
          callId: call._id.toString() 
        });
      });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Error rejecting voice call:', error);
    res.status(500).json({ 
      success: false, 
      error: 'CALL_REJECTION_FAILED' 
    });
  }
});

/**
 * POST /api/voice-call/end/:callId
 * ✅ FIXED: Sends FCM to other user + socket event
 */
router.post('/end/:callId', authenticate, validateCallEnd, async (req, res) => {
  try {
    const userId = req.userId;
    const call = req.voiceCall;
    const { reason = 'user_ended' } = req.body;
    
    await call.end(reason);
    
    console.log('📴 Call ended:', call._id);
    
    // Get other user
    const otherUserId = call.callerId.toString() === userId.toString() 
      ? call.receiverId 
      : call.callerId;
    
    // ✅ Send FCM to other user
    try {
      const otherUser = await User.findById(otherUserId).select('fcmTokens');
      
      if (otherUser && otherUser.fcmTokens && otherUser.fcmTokens.length > 0) {
        const fcmMessage = {
          data: {
            type: 'CALL_ENDED',
            callId: call._id.toString(),
            reason: reason || 'Call ended',
            duration: (call.duration || 0).toString()
          },
          tokens: otherUser.fcmTokens
        };
        
        await admin.messaging().sendEachForMulticast(fcmMessage);
        console.log('✅ FCM sent to other user (call ended)');
      }
    } catch (fcmError) {
      console.error('❌ FCM error:', fcmError);
    }
    
    // ✅ Emit socket event
    const io = req.app.get('io');
    if (io) {
      const otherUserSockets = Array.from(io.sockets.sockets.values())
        .filter(s => s.userId?.toString() === otherUserId.toString());
        
      otherUserSockets.forEach(socket => {
        socket.emit('voice-call-ended', { 
          callId: call._id.toString(), 
          reason, 
          duration: call.duration || 0 
        });
      });
    }
    
    res.json({ 
      success: true, 
      duration: call.duration || 0 
    });
    
  } catch (error) {
    console.error('❌ Error ending voice call:', error);
    res.status(500).json({ 
      success: false, 
      error: 'CALL_END_FAILED' 
    });
  }
});

/**
 * PATCH /api/voice-call/status/:callId
 * Update call status (CONNECTING → CONNECTED)
 */
router.patch('/status/:callId', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const { callId } = req.params;
    const { status } = req.body;
    
    const call = await VoiceCall.findById(callId);
    
    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'CALL_NOT_FOUND'
      });
    }
    
    const isParticipant =
      call.callerId.toString() === userId.toString() ||
      call.receiverId.toString() === userId.toString();
    
    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED'
      });
    }
    
    if (status === 'CONNECTED' && call.status === 'CONNECTING') {
      call.status = 'CONNECTED';
      call.connectedAt = new Date();
      await call.save();
      
      console.log('✅ Voice call connected:', call._id);
    }
    
    res.json({
      success: true,
      status: call.status
    });
    
  } catch (error) {
    console.error('❌ Error updating call status:', error);
    res.status(500).json({
      success: false,
      error: 'STATUS_UPDATE_FAILED'
    });
  }
});

/**
 * GET /api/voice-call/active
 * Get user's active call (if any)
 */
router.get('/active', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    
    const activeCall = await VoiceCall.getUserActiveCall(userId);
    
    if (!activeCall) {
      return res.json({
        success: true,
        hasActiveCall: false,
        call: null
      });
    }
    
    const isCaller = activeCall.callerId.toString() === userId.toString();
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
      error: 'GET_ACTIVE_CALL_FAILED'
    });
  }
});

module.exports = router;
