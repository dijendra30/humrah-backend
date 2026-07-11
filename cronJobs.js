// cronJobs.js - Automated cleanup + surprise meetup reservation expiry
'use strict';

const cron               = require('node-cron');
const RandomBooking      = require('./models/RandomBooking');
const RandomBookingChat  = require('./models/RandomBookingChat');
const EncryptionKey      = require('./models/EncryptionKey');

// ══════════════════════════════════════════════════════════════════════════════
// STARTUP RECOVERY — Resume Broadcasts
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
  try {
    const Broadcast = require('./models/Broadcast');
    const { sendToAudience } = require('./services/broadcastService');
    const stuckBroadcasts = await Broadcast.find({ status: 'SENDING' }).lean();
    for (const b of stuckBroadcasts) {
      console.log(`[STARTUP] Resuming stuck broadcast: ${b._id}`);
      sendToAudience(b._id).catch(e => console.error(`[STARTUP] Failed to resume broadcast ${b._id}:`, e.message));
    }
  } catch (err) {
    console.error('[STARTUP] Error resuming broadcasts:', err.message);
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// EVERY MINUTE — Surprise Meetup reservation expiry
//
// Safety net: if the in-process setTimeout was lost (server restart, crash),
// this cron advances bookings whose reservedUntil has passed.
// Low cost: only fetches bookings with status = RESERVED & reservedUntil < now.
// ══════════════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    const { tickReservationExpiry } = require('./utils/surpriseMeetupMatcher');
    await tickReservationExpiry();
  } catch (err) {
    console.error('[CRON] Reservation expiry tick error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EVERY 5 MINUTES — Official Events: auto-publish Scheduled, auto-expire old
// ══════════════════════════════════════════════════════════════════════════════
cron.schedule('*/5 * * * *', async () => {
  try {
    const { runOfficialEventsCron } = require('./cronJobs/officialEventsCron');
    await runOfficialEventsCron();
  } catch (err) {
    console.error('[CRON] Official Events tick error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EVERY HOUR — general cleanup
// ══════════════════════════════════════════════════════════════════════════════
cron.schedule('0 * * * *', async () => {
  console.log(`\n🧹 [CRON] Hourly cleanup — ${new Date().toISOString()}`);

  try {
    // 1. Mark expired bookings (PENDING / SEARCHING / RESERVED past expiresAt)
    const expiredResult = await RandomBooking.cleanupExpired();
    console.log(`✅ [CRON] Expired bookings marked: ${expiredResult.modifiedCount || 0}`);

    // 2. Delete expired chats
    const deletedChats = await RandomBookingChat.cleanupExpired();
    console.log(`✅ [CRON] Chats cleaned: ${deletedChats.deleted}/${deletedChats.total}`);

    // 3. Clean up encryption keys
    const deletedKeys = await EncryptionKey.cleanupExpired();
    console.log(`✅ [CRON] Encryption keys cleaned: ${deletedKeys.modifiedCount || 0}`);

    // 4. Auto-expire Safety Tickets
    const { checkExpiry: checkSafetyExpiry } = require('./cronJobs/safetyTicketExpiry');
    await checkSafetyExpiry();

    // 5. Clean orphan letter data (replies, reactions, reports)
    try {
      const LetterReply = require('./models/LetterReply');
      const LetterReaction = require('./models/LetterReaction');
      const LetterReport = require('./models/LetterReport');
      const LetterNotification = require('./models/LetterNotification');
      const Letter = require('./models/Letter');
      
      const activeLetters = await Letter.find({}, '_id').lean();
      const existingLetterIds = activeLetters.map(l => l._id);

      const [repliesRes, reactionsRes, reportsRes, notifRes] = await Promise.all([
        LetterReply.deleteMany({ letterId: { $nin: existingLetterIds } }),
        LetterReaction.deleteMany({ letterId: { $nin: existingLetterIds } }),
        LetterReport.deleteMany({ letterId: { $nin: existingLetterIds } }),
        LetterNotification.deleteMany({ letterId: { $nin: existingLetterIds } })
      ]);

      console.log('🧹 [Letters Cleanup]');
      console.log(`   Deleted orphan replies: ${repliesRes.deletedCount}`);
      console.log(`   Deleted orphan reactions: ${reactionsRes.deletedCount}`);
      console.log(`   Deleted orphan reports: ${reportsRes.deletedCount}`);
      console.log(`   Deleted orphan notifications: ${notifRes.deletedCount}`);
    } catch (err) {
      console.error('[CRON] Letters orphan cleanup error:', err.message);
    }

    console.log('✨ [CRON] Hourly cleanup complete\n');
  } catch (err) {
    console.error('❌ [CRON] Hourly cleanup error:', err);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DAILY MIDNIGHT — stats report
// ══════════════════════════════════════════════════════════════════════════════
cron.schedule('0 0 * * *', async () => {
  console.log('📊 [CRON] Daily stats report');

  try {
    const WeeklyUsage = require('./models/WeeklyUsage');
    const yesterday   = new Date(Date.now() - 24 * 3600 * 1000);

    const [total, active, matchedToday, surpriseMatchedToday, weeklyStats] = await Promise.all([
      RandomBooking.countDocuments(),
      RandomBooking.countDocuments({ status: { $in: ['PENDING', 'SEARCHING', 'RESERVED'] } }),
      RandomBooking.countDocuments({ status: 'MATCHED',  matchedAt: { $gte: yesterday } }),
      RandomBooking.countDocuments({ status: 'MATCHED',  activityType: 'CASUAL', matchedAt: { $gte: yesterday } }),
      WeeklyUsage.getStatistics().catch(() => ({ totalUsers: 'n/a', totalBookings: 'n/a' })),
    ]);

    console.log('📈 [STATS]');
    console.log(`   Total bookings:           ${total}`);
    console.log(`   Active (searching):        ${active}`);
    console.log(`   Matched today (all):       ${matchedToday}`);
    console.log(`   Matched today (surprise):  ${surpriseMatchedToday}`);
    console.log(`   Weekly users:              ${weeklyStats.totalUsers}`);
    console.log(`   Weekly bookings:           ${weeklyStats.totalBookings}`);
    console.log('---------------------------------------------------\n');
    
    // Humrah Letters Daily Analytics
    try {
      console.log('📊 [CRON] Humrah Letters Analytics');
      const { runDailyAnalytics } = require('./utils/analyticsHelper');
      await runDailyAnalytics();
    } catch (err) {
      console.error('❌ [CRON] Humrah Letters Analytics error:', err);
    }
    
  } catch (err) {
    console.error('❌ [CRON] Stats error:', err);
  }
});

console.log('🤖 Cron jobs initialised');
console.log('   • Reservation expiry tick: every minute');
console.log('   • Official Events tick:    every 5 minutes');
console.log('   • General cleanup:         every hour');
console.log('   • Stats report:            daily at midnight\n');

// ══════════════════════════════════════════════════════════════════════════════
// AI Moderation Worker (Runs continuously in background)
// ══════════════════════════════════════════════════════════════════════════════
const runModerationWorker = require('./cronJobs/aiModerationWorker');
runModerationWorker();
console.log('🤖 AI Moderation Worker initialized');
