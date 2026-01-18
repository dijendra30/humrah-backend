// cronJobs.js - Automated Cleanup Tasks for Random Booking System
const cron = require('node-cron');
const RandomBooking = require('./models/RandomBooking');
const RandomBookingChat = require('./models/RandomBookingChat');
const EncryptionKey = require('./models/EncryptionKey');

/**
 * Run cleanup tasks every hour
 * Cron pattern: '0 * * * *' = Every hour at minute 0
 */
cron.schedule('0 * * * *', async () => {
  console.log('🧹 [CRON] Running random booking cleanup tasks...');
  console.log(`🕐 [CRON] Time: ${new Date().toISOString()}`);
  
  try {
    // ===== TASK 1: Cleanup Expired Bookings =====
    console.log('📋 [CRON] Task 1: Marking expired bookings...');
    const expiredResult = await RandomBooking.cleanupExpired();
    console.log(`✅ [CRON] Marked ${expiredResult.nModified || 0} bookings as EXPIRED`);
    
    // ===== TASK 2: Delete Expired Chats =====
    console.log('💬 [CRON] Task 2: Deleting expired chats...');
    const deletedChats = await RandomBookingChat.cleanupExpired();
    console.log(`✅ [CRON] Deleted ${deletedChats.deleted}/${deletedChats.total} expired chats`);
    console.log(`ℹ️  [CRON] ${deletedChats.total - deletedChats.deleted} chats preserved (under review or errors)`);
    
    // ===== TASK 3: Cleanup Encryption Keys =====
    console.log('🔐 [CRON] Task 3: Cleaning up encryption keys...');
    const deletedKeys = await EncryptionKey.cleanupExpired();
    console.log(`✅ [CRON] Cleaned up ${deletedKeys.nModified || 0} encryption keys`);
    
    console.log('✨ [CRON] All cleanup tasks completed successfully');
    console.log('---------------------------------------------------\n');
    
  } catch (error) {
    console.error('❌ [CRON] Cleanup error:', error);
    console.error('Stack trace:', error.stack);
  }
});

/**
 * Optional: Run stats report every day at midnight
 */
cron.schedule('0 0 * * *', async () => {
  console.log('📊 [CRON] Running daily statistics report...');
  
  try {
    const RandomBooking = require('./models/RandomBooking');
    const WeeklyUsage = require('./models/WeeklyUsage');
    
    const [
      totalBookings,
      activeBookings,
      matchedToday,
      weeklyStats
    ] = await Promise.all([
      RandomBooking.countDocuments(),
      RandomBooking.countDocuments({ status: 'PENDING' }),
      RandomBooking.countDocuments({
        status: 'MATCHED',
        matchedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }),
      WeeklyUsage.getStatistics()
    ]);
    
    console.log('📈 [STATS] Daily Report:');
    console.log(`   Total Bookings: ${totalBookings}`);
    console.log(`   Active (Pending): ${activeBookings}`);
    console.log(`   Matched Today: ${matchedToday}`);
    console.log(`   Weekly Users: ${weeklyStats.totalUsers}`);
    console.log(`   Weekly Bookings: ${weeklyStats.totalBookings}`);
    console.log('---------------------------------------------------\n');
    
  } catch (error) {
    console.error('❌ [CRON] Stats report error:', error);
  }
});

console.log('🤖 Random Booking Cron Jobs Initialized');
console.log('⏰ Cleanup Task: Every hour');
console.log('📊 Stats Report: Daily at midnight');
console.log('---------------------------------------------------\n');
