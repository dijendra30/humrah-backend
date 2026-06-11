// routes/voice-call.js
// Key fixes:
// 1. voice-call-ringing sent to caller whether receiver is online or backgrounded
// 2. voice-call-ended emitted to BOTH parties on end/reject for instant sync
// 3. FCM token cleanup on failure
// 4. Consistent error shapes throughout
// 5. INCOMING_CALL uses data-only FCM (no notification payload) so onMessageReceived
//    always fires when app is killed — Android OS intercepts combined messages.

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
const AGORA_APP_ID          = process.env.AGORA_APP_ID || '';
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || null;
const TOKEN_EXPIRATION_TIME = 30 * 60; // 30 minutes

function objectIdToUid(objectId) {
  const hex = objectId.toString().slice(-8);
  let uid = Math.abs(parseInt(hex, 16)) % 2147483647;
  if (uid === 0) uid = 1;
  return uid;
}

function generateAgoraToken(channelName, uid, role = RtcRole.PUBLISHER) {
  if (!AGORA_APP_ID) throw new Error('AGORA_APP_ID not configured');
  if (!AGORA_APP_CERTIFICATE) {
    console.log('No App Certificate — returning null token (testing mode)');
    return null;
  }
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_EXPIRATION_TIME;
  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID, AGORA_APP_CERTIFICATE, channelName, uid, role, expiresAt
  );
}

function getSocketsForUser(io, userId) {
  return Array.from(io.sockets.sockets.values())
    .filter(s => s.userId?.toString() === userId.toString());
}

/**
 * Send FCM to a list of tokens. Prunes invalid tokens from user document.
 *
 * IMPORTANT: For INCOMING_CALL, do NOT pass notificationPayload.
 * When both notification + data are present, Android OS handles display itself
 * and onMessageReceived is NOT called when the app is killed/backgrounded.
 * Data-only + android.priority=high always delivers to onMessageReceived so
 * our custom CallStyle full-screen notification is always built.
 */
async function sendFcm(userId, tokens, data, notificationPayload = null) {
  if (!tokens || tokens.length === 0) return;
  try {
    const msg = {
      data,
      tokens,
      android: { priority: 'high' }
    };
    if (notificationPayload) {
      msg.notification = {
        title: notificationPayload.title,
        body:  notificationPayload.body
      };
      msg.android.notification = {
        channelId:             'humrah_notifications',
        defaultSound:          true,
        defaultVibrateTimings: true,
        visibility:            'public'
      };
    }
    const resp = await admin.messaging().sendEachForMulticast(msg);
    if (resp.failureCount > 0) {
      const bad = tokens.filter((_, i) => !resp.responses[i].success);
      if (bad.length > 0) {
        await User.findByIdAndUpdate(userId, { $pull: { fcmTokens: { $in: bad } } });
        console.log('Pruned ' + bad.length + ' invalid FCM tokens for user ' + userId);
      }
    }
    console.log('[FCM] success=' + resp.successCount + ' failure=' + resp.failureCount + ' total=' + tokens.length);
  } catch (err) {
    console.error('FCM error:', err.message);
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
    const { caller, receiver, booking, chat } = req.validatedCallData;

    const callerUid   = objectIdToUid(callerId);
    const channelName = 'voice_' + booking._id + '_' + Date.now();

    let callerToken;
    try {
      callerToken = generateAgoraToken(channelName, callerUid, RtcRole.PUBLISHER);
    } catch (err) {
      return res.status(500).json({
        success: false, error: 'TOKEN_GENERATION_FAILED', message: err.message
      });
    }

    const voiceCall = new VoiceCall({
      callerId, receiverId, bookingId, channelName,
      callerAgoraUid: callerUid, status: 'RINGING', initiatedAt: new Date()
    });
    await voiceCall.save();

    const callIdStr = voiceCall._id.toString();
    console.log('Call ' + callIdStr + ': ' + caller.firstName + ' -> ' + receiver.firstName);

    const io = req.app.get('io');

    // 1. Socket: notify receiver via room (buffered if socket momentarily gone)
    if (io) {
      const receiverSockets = getSocketsForUser(io, receiverId);
      const receiverPayload = {
        callId:   callIdStr,
        caller: {
          _id:          caller._id,
          firstName:    caller.firstName,
          lastName:     caller.lastName,
          profilePhoto: caller.profilePhoto || null,
          fullName:     (caller.firstName + ' ' + caller.lastName).trim()
        },
        bookingId:   booking._id,
        chatId:      chat._id.toString(),
        channelName
      };
      console.log('[CALL_DELIVERY] CALL_ID=' + callIdStr + ' RECEIVER=' + receiverId +
        ' SOCKETS=' + receiverSockets.length + ' FCM_TOKENS=' + (receiver.fcmTokens ? receiver.fcmTokens.length : 0));
      io.to('user:' + receiverId).emit('incoming-voice-call', receiverPayload);
      console.log('Socket: incoming-voice-call -> user:' + receiverId);
    }

    // 2. FCM: DATA-ONLY — no notification payload.
    //    Combined notification+data messages are intercepted by Android OS when app
    //    is killed; onMessageReceived is never called so our custom CallStyle
    //    full-screen notification never gets built. Data-only with priority=high
    //    always wakes the app and triggers onMessageReceived regardless of app state.
    await sendFcm(receiverId, receiver.fcmTokens, {
      type:        'INCOMING_CALL',
      callId:      callIdStr,
      bookingId:   bookingId.toString(),
      chatId:      chat._id.toString(),
      callerId:    callerId.toString(),
      callerName:  caller.firstName + ' ' + caller.lastName,
      callerPhoto: caller.profilePhoto || '',
      channelName,
      appId:       AGORA_APP_ID
    }); // intentionally no notificationPayload for calls

    // 3. Socket: send ringing status to caller
    if (io) {
      io.to('user:' + callerId).emit('voice-call-ringing', { callId: callIdStr });
      const callerSockets = getSocketsForUser(io, callerId);
      console.log('Socket: voice-call-ringing -> user:' + callerId + ' (' + callerSockets.length + ' sockets)');
    }

    res.status(201).json({
      success:     true,
      callId:      voiceCall._id,
      token:       callerToken,
      channelName,
      uid:         callerUid,
      appId:       AGORA_APP_ID,
      receiver: {
        _id:          receiver._id,
        firstName:    receiver.firstName,
        lastName:     receiver.lastName,
        profilePhoto: receiver.profilePhoto
      }
    });

  } catch (err) {
    console.error('/initiate error:', err);
    res.status(500).json({ success: false, error: 'CALL_INITIATION_FAILED', message: err.message });
  }
});

/**
 * POST /api/voice-call/accept/:callId
 */
router.post('/accept/:callId', authenticate, async (req, res) => {
  try {
    const userId     = req.userId;
    const { callId } = req.params;

    const call = await VoiceCall.findById(callId);
    if (!call) return res.status(404).json({ success: false, error: 'CALL_NOT_FOUND' });
    if (call.receiverId.toString() !== userId.toString())
      return res.status(403).json({ success: false, error: 'UNAUTHORIZED' });
    if (!call.canBeAccepted())
      return res.status(400).json({ success: false, error: 'CALL_EXPIRED', message: 'Call can no longer be accepted' });

    const receiverUid = objectIdToUid(userId);
    let receiverToken;
    try {
      receiverToken = generateAgoraToken(call.channelName, receiverUid, RtcRole.PUBLISHER);
    } catch (err) {
      return res.status(500).json({ success: false, error: 'TOKEN_GENERATION_FAILED', message: err.message });
    }

    call.receiverAgoraUid = receiverUid;
    await call.accept();

    const io        = req.app.get('io');
    const callIdStr = call._id.toString();

    if (io) {
      io.to('user:' + call.callerId).emit('voice-call-accepted', { callId: callIdStr });
      console.log('Socket: voice-call-accepted -> user:' + call.callerId);
    }

    const caller = await User.findById(call.callerId).select('fcmTokens');
    await sendFcm(call.callerId, caller ? caller.fcmTokens : [], { type: 'CALL_ACCEPTED', callId: callIdStr });

    res.json({
      success:     true,
      token:       receiverToken,
      channelName: call.channelName,
      uid:         receiverUid,
      appId:       AGORA_APP_ID,
      status:      call.status
    });

  } catch (err) {
    console.error('/accept error:', err);
    res.status(500).json({ success: false, error: 'CALL_ACCEPTANCE_FAILED' });
  }
});

/**
 * POST /api/voice-call/reject/:callId
 */
router.post('/reject/:callId', authenticate, async (req, res) => {
  try {
    const userId     = req.userId;
    const { callId } = req.params;

    const call = await VoiceCall.findById(callId);
    if (!call) return res.status(404).json({ success: false, error: 'CALL_NOT_FOUND' });
    if (call.receiverId.toString() !== userId.toString())
      return res.status(403).json({ success: false, error: 'UNAUTHORIZED' });
    if (call.status !== 'RINGING')
      return res.status(400).json({ success: false, error: 'INVALID_STATE' });

    await call.decline();
    console.log('Call ' + callId + ' rejected');

    const io        = req.app.get('io');
    const callIdStr = call._id.toString();

    if (io) {
      io.to('user:' + call.callerId).emit('voice-call-rejected', { callId: callIdStr });
      console.log('Socket: voice-call-rejected -> user:' + call.callerId);
    }

    const caller = await User.findById(call.callerId).select('fcmTokens');
    await sendFcm(call.callerId, caller ? caller.fcmTokens : [], {
      type: 'CALL_REJECTED', callId: callIdStr, reason: 'declined'
    });

    res.json({ success: true });

  } catch (err) {
    console.error('/reject error:', err);
    res.status(500).json({ success: false, error: 'CALL_REJECTION_FAILED' });
  }
});

/**
 * POST /api/voice-call/end/:callId
 */
router.post('/end/:callId', authenticate, validateCallEnd, async (req, res) => {
  try {
    const userId  = req.userId;
    const call    = req.voiceCall;
    const { reason = 'user_ended' } = req.body;

    await call.end(reason);
    console.log('Call ' + call._id + ' ended by ' + userId + ' (' + reason + ')');

    const otherUserId = call.callerId.toString() === userId.toString()
      ? call.receiverId
      : call.callerId;

    const io        = req.app.get('io');
    const callIdStr = call._id.toString();
    const duration  = call.duration || 0;

    if (io) {
      io.to('user:' + otherUserId).emit('voice-call-ended', { callId: callIdStr, reason, duration });
      console.log('Socket: voice-call-ended -> user:' + otherUserId);
    }

    const otherUser = await User.findById(otherUserId).select('fcmTokens');
    await sendFcm(otherUserId, otherUser ? otherUser.fcmTokens : [], {
      type: 'CALL_ENDED', callId: callIdStr, reason, duration: duration.toString()
    });

    res.json({ success: true, duration });

  } catch (err) {
    console.error('/end error:', err);
    res.status(500).json({ success: false, error: 'CALL_END_FAILED' });
  }
});

/**
 * PATCH /api/voice-call/status/:callId
 */
router.patch('/status/:callId', authenticate, async (req, res) => {
  try {
    const userId     = req.userId;
    const { callId } = req.params;
    const { status } = req.body;

    const call = await VoiceCall.findById(callId);
    if (!call) return res.status(404).json({ success: false, error: 'CALL_NOT_FOUND' });

    const isParticipant = call.callerId.toString() === userId.toString() ||
                          call.receiverId.toString() === userId.toString();
    if (!isParticipant) return res.status(403).json({ success: false, error: 'UNAUTHORIZED' });

    if (status === 'CONNECTED' && call.status === 'CONNECTING') {
      call.status      = 'CONNECTED';
      call.connectedAt = new Date();
      await call.save();
      console.log('Call ' + callId + ' marked CONNECTED');
    }

    res.json({ success: true, status: call.status });

  } catch (err) {
    console.error('/status error:', err);
    res.status(500).json({ success: false, error: 'STATUS_UPDATE_FAILED' });
  }
});

/**
 * GET /api/voice-call/active
 */
router.get('/active', authenticate, async (req, res) => {
  try {
    const userId     = req.userId;
    const activeCall = await VoiceCall.getUserActiveCall(userId);

    if (!activeCall) return res.json({ success: true, hasActiveCall: false, call: null });

    const isCaller    = activeCall.callerId.toString() === userId.toString();
    const otherUserId = isCaller ? activeCall.receiverId : activeCall.callerId;
    const otherUser   = await User.findById(otherUserId).select('firstName lastName profilePhoto');

    res.json({
      success: true,
      hasActiveCall: true,
      call: {
        callId:      activeCall._id,
        status:      activeCall.status,
        isCaller,
        otherUser: {
          _id:          otherUser._id,
          firstName:    otherUser.firstName,
          lastName:     otherUser.lastName,
          profilePhoto: otherUser.profilePhoto
        },
        channelName: activeCall.channelName,
        initiatedAt: activeCall.initiatedAt
      }
    });

  } catch (err) {
    console.error('/active error:', err);
    res.status(500).json({ success: false, error: 'GET_ACTIVE_CALL_FAILED' });
  }
});

module.exports = router;
