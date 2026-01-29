// routes/voice-call.js - COMPLETE WITH CALL LOGS
const express = require('express');
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const VoiceCall = require('../models/VoiceCall');
const User = require('../models/User');
const Message = require('../models/Message'); // ✅ ADD: For call logs
const RandomBooking = require('../models/RandomBooking'); // ✅ ADD: For getting chatId
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
 */
function objectIdToUid(objectId) {
  const objectIdString = objectId.toString();
  const hex = objectIdString.slice(-8);
  let uid = parseInt(hex, 16);
  const SIGNED_INT_MAX = 2147483647;
  uid = Math.abs(uid) % SIGNED_INT_MAX;
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

/**
 * ✅ NEW: Create call log message in chat
 */
async function createCallLogMessage(booking, callId, content, metadata = {}) {
  try {
    if (!booking.chatId) {
      console.log('⚠️ No chatId in booking - cannot create call log');
      return null;
    }

    const callLogMessage = new Message({
      chatId: booking.chatId,
      senderId: booking.initiatorId,
      content: content,
      messageType: 'SYSTEM',
      isSystemMessage: true,
      metadata: {
        callId: callId.toString(),
        callType: 'VOICE',
        ...metadata,
        timestamp: new Date().toISOString()
      }
    });

    await callLogMessage.save();
    console.log('✅ Call log message saved to chat');

    return callLogMessage;
  } catch (error) {
    console.error('❌ Error creating call log:', error);
    return null;
  }
}

/**
 * ✅ NEW: Emit call log via Socket.IO
 */
function emitCallLog(io, chatId, message) {
  if (!io || !message) return;

  try {
    io.to(chatId.toString()).emit('new-message', {
      ...message.toObject(),
      _id: message._id.toString(),
      chatId: chatId.toString(),
      senderId: message.senderId.toString()
    });
    console.log('✅ Call log emitted via socket');
  } catch (error) {
    console.error('❌ Error emitting call log:', error);
  }
}

// ==================== ROUTES ====================

/**
 * POST /api/voice-call/initiate
 * ✅ NOW WITH CALL LOG
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
    
    const callerUid = objectIdToUid(callerId);
    const channelName = `voice_${booking._id}_${Date.now()}`;
    
    console.log('\n📋 Call Configuration:');
    console.log(`   Channel Name: ${channelName}`);
    console.log(`   Caller UID: ${callerUid}`);
    
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

    // ✅ NEW: Create call initiation log message
    const callLogMessage = await createCallLogMessage(
      booking,
      voiceCall._id,
      `📞 Voice call initiated by ${caller.firstName}`,
      {
        callStatus: 'INITIATED',
        callerName: `${caller.firstName} ${caller.lastName}`.trim()
      }
    );

    // ✅ NEW: Emit call log to chat
    if (callLogMessage) {
      const io = req.app.get('io');
      emitCallLog(io, booking.chatId, callLogMessage);
    }
    
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
    
    // Emit socket event for incoming call
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
    console.error('\n❌ ERROR INITIATING VOICE CALL');
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    
    res.status(500).json({
      success: false,
      error: 'CALL_INITIATION_FAILED',
      message: 'Failed to initiate voice call',
      details: error.message
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
        message: 'You are not the receiver of this call'
      });
    }
    
    if (!call.canBeAccepted()) {
      return res.status(400).json({
        success: false,
        error: 'CALL_CANNOT_BE_ACCEPTED',
        message: 'This call can no longer be accepted'
      });
    }
    
    const receiverUid = objectIdToUid(userId);
    console.log(`\n📋 Receiver Configuration:`);
    console.log(`   Channel Name: ${call.channelName}`);
    console.log(`   Receiver UID: ${receiverUid}`);
    
    let receiverToken;
    try {
      receiverToken = generateAgoraToken(call.channelName, receiverUid, RtcRole.PUBLISHER);
    } catch (tokenError) {
      console.error('\n❌ TOKEN GENERATION FAILED FOR RECEIVER');
      console.error(`   Error: ${tokenError.message}`);
      
      return res.status(500).json({
        success: false,
        error: 'TOKEN_GENERATION_FAILED',
        message: 'Failed to generate authentication token'
      });
    }
    
    call.status = 'CONNECTING';
    call.acceptedAt = new Date();
    call.receiverAgoraUid = receiverUid;
    await call.save();
    
    console.log(`\n✅ Call Status Updated: CONNECTING`);
    
    // Notify caller
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
    
    // Emit socket event
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
      appId: AGORA_APP_ID
    });
    
  } catch (error) {
    console.error('\n❌ ERROR ACCEPTING VOICE CALL');
    console.error(`   Error: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: 'CALL_ACCEPTANCE_FAILED',
      message: 'Failed to accept voice call'
    });
  }
});

/**
 * POST /api/voice-call/reject/:callId
 * ✅ NOW WITH CALL LOG
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

    // ✅ NEW: Create missed call log
    const booking = await RandomBooking.findById(call.bookingId);
    if (booking && booking.chatId) {
      const receiver = await User.findById(userId).select('firstName lastName');
      const callLogMessage = await createCallLogMessage(
        booking,
        call._id,
        `📞 Missed voice call (declined by ${receiver.firstName})`,
        {
          callStatus: 'DECLINED',
          declinedBy: `${receiver.firstName} ${receiver.lastName}`.trim()
        }
      );

      // Emit to chat
      if (callLogMessage) {
        const io = req.app.get('io');
        emitCallLog(io, booking.chatId, callLogMessage);
      }
    }
    
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
 * ✅ NOW WITH CALL LOG
 */
router.post('/end/:callId', authenticate, validateCallEnd, async (req, res) => {
  try {
    const userId = req.userId;
    const call = req.voiceCall;
    const { reason = 'user_ended' } = req.body;
    
    await call.end(reason);
    console.log(`📴 Call ended: ${call._id} (${reason})`);

    // ✅ NEW: Create call end log message
    const booking = await RandomBooking.findById(call.bookingId);
    if (booking && booking.chatId) {
      const endingUser = await User.findById(userId).select('firstName lastName');
      
      // Format duration
      const durationText = call.duration 
        ? `${Math.floor(call.duration / 60)}m ${call.duration % 60}s`
        : 'Not connected';
      
      // Format end reason
      const reasonText = reason === 'user_ended' 
        ? 'Call ended' 
        : reason.replace(/_/g, ' ');

      const callLogMessage = await createCallLogMessage(
        booking,
        call._id,
        `📞 ${reasonText}. Duration: ${durationText}`,
        {
          callStatus: 'ENDED',
          duration: call.duration || 0,
          endReason: reason,
          endedBy: `${endingUser.firstName} ${endingUser.lastName}`.trim()
        }
      );

      // Emit to chat
      if (callLogMessage) {
        const io = req.app.get('io');
        emitCallLog(io, booking.chatId, callLogMessage);
      }
    }
    
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
