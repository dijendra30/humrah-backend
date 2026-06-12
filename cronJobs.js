// cronJobs.js - Automated cleanup + surprise meetup reservation expiry
'use strict';

const cron               = require('node-cron');
const RandomBooking      = require('./models/RandomBooking');
const RandomBookingChat  = require('./models/RandomBookingChat');
const EncryptionKey      = require('./models/EncryptionKey');

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
  } catch (err) {
    console.error('❌ [CRON] Stats error:', err);
  }
});

console.log('🤖 Cron jobs initialised');
console.log('   • Reservation expiry tick: every minute');
console.log('   • General cleanup:         every hour');
console.log('   • Stats report:            daily at midnight\n');

// ══════════════════════════════════════════════════════════════════════════════
// AI Moderation Worker (Runs continuously in background)
// ══════════════════════════════════════════════════════════════════════════════
const runModerationWorker = require('./cronJobs/aiModerationWorker');
runModerationWorker();
console.log('🤖 AI Moderation Worker initialized');
