// cronJobs/voice-call-cleanup.js - Voice Call Cleanup Tasks
const cron = require('node-cron');
const VoiceCall = require('../models/VoiceCall');

/**
 * Run cleanup tasks every minute
 * - Timeout stale RINGING calls (>30 seconds)
 * - Expire long CONNECTED calls (>2 hours)
 */
cron.schedule('* * * * *', async () => {
  try {
    // Cleanup stale RINGING calls (older than 30 seconds)
    const timeoutCount = await VoiceCall.cleanupStaleCalls();
    if (timeoutCount > 0) {
      console.log(`⏰ [VOICE-CALL] Timed out ${timeoutCount} stale call(s)`);
    }
    
    // Expire long CONNECTED calls (older than 2 hours)
    const expiredCount = await VoiceCall.expireConnectedCalls();
    if (expiredCount > 0) {
      console.log(`⏰ [VOICE-CALL] Expired ${expiredCount} long call(s)`);
    }
  } catch (error) {
    console.error('❌ [VOICE-CALL] Cleanup error:', error);
  }
});

console.log('🤖 Voice Call Cleanup Cron Job Initialized');
console.log('⏰ Runs every minute');
console.log('---------------------------------------------------\n');

module.exports = {};
