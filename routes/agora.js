// routes/agora.js - AGORA TOKEN GENERATION
const express = require('express');
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const { auth } = require('../middleware/auth');

// ✅ REPLACE WITH YOUR CREDENTIALS
const AGORA_APP_ID = '183926da16b6416f98b50a78c6673c97';
const AGORA_APP_CERTIFICATE = '4cc9dde943ca49a398fd120ebb1207ba';

/**
 * Generate Agora RTC Token
 * POST /api/agora/token
 */
router.post('/token', auth, async (req, res) => {
  try {
    const { channelName, uid, role } = req.body;
    
    if (!channelName) {
      return res.status(400).json({
        success: false,
        message: 'Channel name is required'
      });
    }
    
    // Token expiration time (24 hours)
    const expirationTimeInSeconds = 24 * 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    
    // User UID (0 = auto-generate)
    const uidNumber = uid || 0;
    
    // Role (1 = publisher, 2 = subscriber)
    const userRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
    
    // Build token
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uidNumber,
      userRole,
      privilegeExpiredTs
    );
    
    console.log(`✅ Token generated for channel: ${channelName}, uid: ${uidNumber}`);
    
    res.json({
      success: true,
      token,
      appId: AGORA_APP_ID,
      channelName,
      uid: uidNumber,
      expiresAt: new Date(privilegeExpiredTs * 1000).toISOString()
    });
    
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate token',
      error: error.message
    });
  }
});

/**
 * Generate token for specific chat
 * POST /api/agora/token/:chatId
 */
router.post('/token/:chatId', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { isAudioOnly } = req.body;
    
    // Use chatId as channel name
    const channelName = chatId;
    const uid = parseInt(req.userId.slice(-6), 16); // Generate numeric uid from userId
    
    const expirationTimeInSeconds = 24 * 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );
    
    console.log(`✅ Token generated for chat: ${chatId}`);
    
    res.json({
      success: true,
      token,
      appId: AGORA_APP_ID,
      channelName,
      uid,
      isAudioOnly: isAudioOnly || false,
      expiresAt: new Date(privilegeExpiredTs * 1000).toISOString()
    });
    
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate token'
    });
  }
});

module.exports = router;
