// routes/voice-call.js - FIXED VERSION (No Call Log Messages)
const express = require('express');
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const VoiceCall = require('../models/VoiceCall');
const User = require('../models/User');
const admin = require('../config/firebase');
const {
  validateCallInitiation,
  validateCallEnd
} = require('../middleware/voice-call-validator');
const { authenticate } = require('../middleware/auth');

// ==================== AGORA CONFIGURATION ====================
const AGORA_APP_ID = process.env.AGORA_APP_ID || '183926da16b6416f98b50a78c6673c97';
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || null;
const TOKEN_EXPIRATION_TIME = 30 * 60; // 30 minutes

/**
 * ✅ CRITICAL FIX: Convert MongoDB ObjectId to UID in SIGNED 32-bit range
 * Android Int is signed: -2,147,483,648 to 2,147,483,647
 * We MUST keep UIDs within this range to avoid overflow
 */
function objectIdToUid(objectId) {
  const objectIdString = objectId.toString();
  
  // Take last 8 characters of ObjectId and convert to integer
  const hex = objectIdString.slice(-8);
  let uid = parseInt(hex, 16);
  
  // ✅ CRITICAL: Keep within SIGNED 32-bit range for Android
  const SIGNED_INT_MAX = 2147483647;
  
  // Ensure UID is positive and within signed int range
  uid = Math.abs(uid) % SIGNED_INT_MAX;
  
  // Ensure UID is never 0 (add 1 if it is)
  if (uid === 0) uid = 1;
  
  console.log(`🔢 UID Conversion: ${objectIdString.slice(0, 8)}... -> ${hex} -> ${uid}`);
  console.log(`   ✅ UID is within signed 32-bit range (max: ${SIGNED_INT_MAX})`);
  
  return uid;
}

/**
 * ✅ Generate Agora RTC Token
 */
function generateAgoraToken(channelName, uid, role = RtcRole.PUBLISHER) {
  if (!AGORA_APP_ID) {
    throw new Error('Agora App ID not configured');
  }
  
  // ✅ If no certificate, return null (testing mode)
  if (!AGORA_APP_CERTIFICATE) {
    console.log('⚠️ Running in TESTING MODE - No token required');
    console.log('⚠️ DISABLE CERTIFICATE in Agora Console!');
    return null;
  }
  
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTimestamp + TOKEN_EXPIRATION_TIME;
  
  console.log('🔐 Generating Agora Token:');
  console.log(`   App ID: ${AGORA_APP_ID}`);
  console.log(`   Channel: ${channelName}`);
  console.log(`   UID: ${uid}`);
  
  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      role,
      privilegeExpireTime
    );
    
    console.log(`✅ Token generated (length: ${token.length})`);
    return token;
  } catch (error) {
    console.error('❌ Token generation failed:', error);
    throw new Error(`Token generation failed: ${error.message}`);
  }
}

// ==================== ROUTES ====================

/**
 * POST /api/voice-call/initiate
 */
router.post('/initiate', authenticate, validateCallInitiation, async (req, res) => {
  try {
    const callerId = req.userId;
    const { receiverId, bookingId } = req.body;
    
    console.log('\n=================================');
    console.log('📞 VOICE CALL INITIATION REQUEST');
    console.log('=================================');
    console.log(`Caller ID: ${callerId.toString()}`);
    console.log(`Receiver ID: ${receiverId.toString()}`);
    console.log(`Booking ID: ${bookingId.toString()}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    const { caller, receiver, booking } = req.validatedCallData;
    
    // ✅ Generate UID within signed 32-bit range
    const callerUid = objectIdToUid(callerId);
    const channelName = `voice_${booking._id}_${Date.now()}`;
    
    console.log('\n📋 Call Configuration:');
    console.log(`   Channel Name: ${channelName}`);
    console.log(`   Caller UID: ${callerUid}`);
    
    // ✅ Generate token
    let callerToken;
    try {
      callerToken = generateAgoraToken(channelName, callerUid, RtcRole.PUBLISHER);
    } catch (tokenError) {
      console.error('\n❌ TOKEN GENERATION FAILED');
      console.error(`   Error: ${tokenError.message}`);
      
      return res.status(500).json({
        success: false,
        error: 'TOKEN_GENERATION_FAILED',
        message: 'Failed to generate authentication token',
        details: tokenError.message
      });
    }
    
    // Create voice call record
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
    
    console.log(`\n✅ Voice Call Record Created:`);
    console.log(`   Call ID: ${voiceCall._id}`);
    console.log(`   Status: ${voiceCall.status}`);
    
    // Send FCM notification
    try {
      if (receiver.fcmTokens && receiver.fcmTokens.length > 0) {
        console.log(`\n📨 Sending FCM Notification:`);
        console.log(`   To: ${receiver.firstName} ${receiver.lastName}`);
        console.log(`   Token Count: ${receiver.fcmTokens.length}`);
        
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
        console.log(`✅ FCM Sent: ${fcmResponse.successCount}/${receiver.fcmTokens.length} successful`);
        
        if (fcmResponse.failureCount > 0) {
          const failedTokens = [];
          fcmResponse.responses.forEach((resp, idx) => {
            if (!resp.success) {
              failedTokens.push(receiver.fcmTokens[idx]);
            }
          });
          
          if (failedTokens.length > 0) {
            await User.findByIdAndUpdate(receiverId, {
              $pull: { fcmTokens: { $in: failedTokens } }
            });
            console.log(`🧹 Removed ${failedTokens.length} invalid FCM tokens`);
          }
        }
      }
    } catch (fcmError) {
      console.error('\n❌ FCM Send Error:', fcmError);
    }
    
    // Emit socket event
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
        console.log(`\n✅ Socket Event Sent: ${receiverSockets.length} socket(s)`);
      }
    }
    
    // ✅ Return response
    console.log('\n=================================');
    console.log('📤 RESPONSE TO CALLER');
    console.log('=================================');
    console.log(`Call ID: ${voiceCall._id}`);
    console.log(`Channel Name: ${channelName}`);
    console.log(`UID: ${callerUid} (signed 32-bit)`);
    console.log(`App ID: ${AGORA_APP_ID}`);
    console.log(`Token (preview): ${callerToken ? callerToken.substring(0, 20) + '...' : 'null (testing mode)'}`);
    console.log(`Token Length: ${callerToken ? callerToken.length : 0} chars`);
    console.log('=================================\n');
    
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
    console.error('\n❌ Voice Call Initiation Error:', error);
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
router.post('/accept/:callId', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const { callId } = req.params;
    
    console.log('\n=================================');
    console.log('✅ ACCEPTING CALL');
    console.log('=================================');
    console.log(`Call ID: ${callId}`);
    console.log(`Receiver ID: ${userId.toString()}`);
    
    const call = await VoiceCall.findById(callId);
    
    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'CALL_NOT_FOUND',
        message: 'Call not found'
      });
    }
    
    if (call.receiverId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'You are not authorized to accept this call'
      });
    }
    
    if (!call.canBeAccepted()) {
      return res.status(400).json({
        success: false,
        error: 'CALL_EXPIRED',
        message: 'This call can no longer be accepted'
      });
    }
    
    // Generate receiver UID and token
    const receiverUid = objectIdToUid(userId);
    
    console.log('\n📋 Receiver Configuration:');
    console.log(`   Channel Name: ${call.channelName}`);
    console.log(`   Receiver UID: ${receiverUid}`);
    
    // Generate token for receiver
    let receiverToken;
    try {
      receiverToken = generateAgoraToken(call.channelName, receiverUid, RtcRole.PUBLISHER);
      console.log(`✅ Token generated (length: ${receiverToken ? receiverToken.length : 0})`);
    } catch (tokenError) {
      console.error('❌ Token generation failed:', tokenError);
      
      return res.status(500).json({
        success: false,
        error: 'TOKEN_GENERATION_FAILED',
        message: 'Failed to generate authentication token'
      });
    }
    
    // Accept the call
    call.receiverAgoraUid = receiverUid;
    await call.accept();
    
    console.log(`✅ Call Status Updated: ${call.status}`);
    
    // Notify caller via FCM
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
        console.log(`✅ FCM sent to caller (call accepted)`);
      }
    } catch (fcmError) {
      console.error('❌ FCM error:', fcmError);
    }
    
    // Emit socket event to caller
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
    
    // ✅ NO CALL LOG MESSAGE CREATION - REMOVED TO FIX ERROR
    
    console.log('\n=================================');
    console.log('📤 RESPONSE TO RECEIVER');
    console.log('=================================');
    console.log(`Channel Name: ${call.channelName}`);
    console.log(`UID: ${receiverUid} (signed 32-bit)`);
    console.log(`App ID: ${AGORA_APP_ID}`);
    console.log(`Token (preview): ${receiverToken ? receiverToken.substring(0, 20) + '...' : 'null (testing mode)'}`);
    console.log(`Token Length: ${receiverToken ? receiverToken.length : 0} chars`);
    console.log('=================================\n');
    
    res.json({
      success: true,
      token: receiverToken,
      channelName: call.channelName,
      uid: receiverUid,
      appId: AGORA_APP_ID,
      status: call.status
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
    console.log(`❌ Call rejected: ${callId}`);
    
    // Notify caller
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
      }
    } catch (fcmError) {
      console.error('❌ FCM error:', fcmError);
    }
    
    // Emit socket event
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
 */
router.post('/end/:callId', authenticate, validateCallEnd, async (req, res) => {
  try {
    const userId = req.userId;
    const call = req.voiceCall;
    const { reason = 'user_ended' } = req.body;
    
    await call.end(reason);
    console.log(`📴 Call ended: ${call._id} (${reason})`);
    
    // Get other user
    const otherUserId = call.callerId.toString() === userId.toString()
      ? call.receiverId
      : call.callerId;
    
    // Notify other user
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
      }
    } catch (fcmError) {
      console.error('❌ FCM error:', fcmError);
    }
    
    // Emit socket event
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
      error: 'STATUS_UPDATE_FAILED'
    });
  }
});

/**
 * GET /api/voice-call/active
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
