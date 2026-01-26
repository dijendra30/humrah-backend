// cronJobs/voice-call-cleanup.js - PRODUCTION VERSION
// ✅ Enforces 30-minute call duration limit
// ✅ Cleans up stale calls
const cron = require('node-cron');
const VoiceCall = require('../models/VoiceCall');

/**
 * Run cleanup tasks every minute
 * - Timeout stale RINGING calls (>1 minute)
 * - End CONNECTED calls exceeding 30 minutes
 * - Clean up stale CONNECTING calls (>5 minutes)
 */
cron.schedule('* * * * *', async () => {
  try {
    let totalCleaned = 0;
    
    // ==================== 1. TIMEOUT RINGING CALLS (>1 minute) ====================
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    
    const ringingResult = await VoiceCall.updateMany(
      {
        status: 'RINGING',
        initiatedAt: { $lt: oneMinuteAgo }
      },
      {
        $set: {
          status: 'TIMEOUT',
          endedAt: new Date(),
          endReason: 'no_answer'
        }
      }
    );
    
    if (ringingResult.modifiedCount > 0) {
      console.log(`⏰ [VOICE-CALL] Timed out ${ringingResult.modifiedCount} unanswered call(s)`);
      totalCleaned += ringingResult.modifiedCount;
    }
    
    // ==================== 2. END CALLS EXCEEDING 30 MINUTES ✅ ====================
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    
    const longCallsResult = await VoiceCall.updateMany(
      {
        status: 'CONNECTED',
        connectedAt: { $lt: thirtyMinutesAgo }
      },
      {
        $set: {
          status: 'ENDED',
          endedAt: new Date(),
          endReason: 'max_duration_exceeded'
        }
      }
    );
    
    if (longCallsResult.modifiedCount > 0) {
      console.log(`⏰ [VOICE-CALL] Auto-ended ${longCallsResult.modifiedCount} call(s) that exceeded 30 minutes`);
      totalCleaned += longCallsResult.modifiedCount;
    }
    
    // ==================== 3. CLEAN UP STALE CONNECTING CALLS (>5 minutes) ====================
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const staleConnectingResult = await VoiceCall.updateMany(
      {
        status: 'CONNECTING',
        acceptedAt: { $lt: fiveMinutesAgo }
      },
      {
        $set: {
          status: 'FAILED',
          endedAt: new Date(),
          endReason: 'connection_timeout'
        }
      }
    );
    
    if (staleConnectingResult.modifiedCount > 0) {
      console.log(`⏰ [VOICE-CALL] Cleaned ${staleConnectingResult.modifiedCount} stale connecting call(s)`);
      totalCleaned += staleConnectingResult.modifiedCount;
    }
    
    // ==================== 4. LOG SUMMARY ====================
    if (totalCleaned > 0) {
      console.log(`✅ [VOICE-CALL] Total calls cleaned: ${totalCleaned}`);
    }
    
  } catch (error) {
    console.error('❌ [VOICE-CALL] Cleanup error:', error);
  }
});

console.log('');
console.log('🤖 Voice Call Cleanup Cron Job Initialized');
console.log('⏰ Runs every minute');
console.log('📋 Tasks:');
console.log('   - Timeout unanswered calls (>1 minute)');
console.log('   - Auto-end calls exceeding 30 minutes ✅');
console.log('   - Clean stale connecting calls (>5 minutes)');
console.log('---------------------------------------------------');
console.log('');

module.exports = {};
