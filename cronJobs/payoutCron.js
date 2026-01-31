// jobs/payoutCron.js - Automated Payout Processing
const cron = require('node-cron');
const Payout = require('../models/Payout');
const User = require('../models/User');
const Booking = require('../models/Booking');
const { sendEmail } = require('../services/email');

/**
 * Weekly Payout Job
 * Runs every Monday at 9:00 AM
 * Processes payouts for users with pending balance >= ₹500
 */
const weeklyPayoutJob = cron.schedule('0 9 * * 1', async () => {
  console.log('🔄 Running weekly payout job...');
  
  try {
    // Find users eligible for weekly payout
    const eligibleUsers = await User.find({
      'paymentInfo.pendingPayout': { $gte: 500 },
      'paymentInfo.upiStatus': 'verified',
      status: 'ACTIVE',
      'suspensionInfo.isSuspended': false,
      'banInfo.isBanned': false
    }).select('_id firstName email paymentInfo');
    
    console.log(`Found ${eligibleUsers.length} users eligible for payout`);
    
    let successCount = 0;
    let failureCount = 0;
    
    for (const user of eligibleUsers) {
      try {
        // Get unpaid bookings for this user
        const unpaidBookings = await Booking.find({
          companionId: user._id,
          status: 'completed',
          paymentStatus: 'paid',
          earningsPaidOut: false
        }).select('_id companionEarning');
        
        if (unpaidBookings.length === 0) {
          console.log(`No unpaid bookings for user ${user._id}`);
          continue;
        }
        
        const totalAmount = unpaidBookings.reduce((sum, b) => sum + b.companionEarning, 0);
        const bookingIds = unpaidBookings.map(b => b._id);
        
        // Create payout
        const payout = await Payout.createPayout(user._id, totalAmount, bookingIds);
        
        // Process payout
        const success = await payout.process();
        
        if (success) {
          successCount++;
          console.log(`✅ Payout successful for user ${user._id}: ₹${totalAmount}`);
        } else {
          failureCount++;
          console.log(`❌ Payout failed for user ${user._id}`);
        }
        
      } catch (error) {
        console.error(`Error processing payout for user ${user._id}:`, error);
        failureCount++;
      }
    }
    
    console.log(`✅ Weekly payout job completed: ${successCount} successful, ${failureCount} failed`);
    
    // Send admin summary email
    if (successCount > 0 || failureCount > 0) {
      await sendEmail({
        to: 'admin@humrah.in',
        subject: 'Weekly Payout Summary',
        html: `
          <h2>Weekly Payout Summary</h2>
          <p>Date: ${new Date().toLocaleDateString()}</p>
          <ul>
            <li>Total eligible users: ${eligibleUsers.length}</li>
            <li>Successful payouts: ${successCount}</li>
            <li>Failed payouts: ${failureCount}</li>
          </ul>
        `
      });
    }
    
  } catch (error) {
    console.error('Weekly payout job error:', error);
  }
});

/**
 * Monthly Payout Job
 * Runs on the 1st of every month at 9:00 AM
 * Processes payouts for users with pending balance < ₹500
 */
const monthlyPayoutJob = cron.schedule('0 9 1 * *', async () => {
  console.log('🔄 Running monthly payout job...');
  
  try {
    // Find users eligible for monthly payout
    const eligibleUsers = await User.find({
      'paymentInfo.pendingPayout': { $gt: 0, $lt: 500 },
      'paymentInfo.upiStatus': 'verified',
      status: 'ACTIVE',
      'suspensionInfo.isSuspended': false,
      'banInfo.isBanned': false
    }).select('_id firstName email paymentInfo');
    
    console.log(`Found ${eligibleUsers.length} users eligible for monthly payout`);
    
    let successCount = 0;
    let failureCount = 0;
    
    for (const user of eligibleUsers) {
      try {
        const unpaidBookings = await Booking.find({
          companionId: user._id,
          status: 'completed',
          paymentStatus: 'paid',
          earningsPaidOut: false
        }).select('_id companionEarning');
        
        if (unpaidBookings.length === 0) continue;
        
        const totalAmount = unpaidBookings.reduce((sum, b) => sum + b.companionEarning, 0);
        const bookingIds = unpaidBookings.map(b => b._id);
        
        const payout = await Payout.createPayout(user._id, totalAmount, bookingIds);
        const success = await payout.process();
        
        if (success) {
          successCount++;
        } else {
          failureCount++;
        }
        
      } catch (error) {
        console.error(`Error processing monthly payout for user ${user._id}:`, error);
        failureCount++;
      }
    }
    
    console.log(`✅ Monthly payout job completed: ${successCount} successful, ${failureCount} failed`);
    
  } catch (error) {
    console.error('Monthly payout job error:', error);
  }
});

/**
 * Retry Failed Payouts Job
 * Runs every hour
 * Retries payouts that failed but have retry attempts remaining
 */
const retryPayoutJob = cron.schedule('0 * * * *', async () => {
  console.log('🔄 Running payout retry job...');
  
  try {
    const pendingRetries = await Payout.getPendingRetries();
    
    console.log(`Found ${pendingRetries.length} payouts to retry`);
    
    for (const payout of pendingRetries) {
      try {
        const success = await payout.process();
        
        if (success) {
          console.log(`✅ Retry successful for payout ${payout._id}`);
        } else {
          console.log(`❌ Retry failed for payout ${payout._id}`);
          
          // Notify user if all retries exhausted
          if (payout.retryCount >= 3) {
            await sendEmail({
              to: payout.userId.email,
              subject: 'Payout Failed - Action Required',
              html: `
                <h2>Payout Failed</h2>
                <p>Hello,</p>
                <p>We were unable to process your payout of ₹${payout.amount} after multiple attempts.</p>
                <p>Reason: ${payout.failureReason}</p>
                <p>Please update your UPI ID in your profile settings.</p>
                <p>If you need assistance, please contact support@humrah.in</p>
              `
            });
          }
        }
        
      } catch (error) {
        console.error(`Error retrying payout ${payout._id}:`, error);
      }
    }
    
  } catch (error) {
    console.error('Retry payout job error:', error);
  }
});

/**
 * Update Earnings on Booking Completion
 * This is triggered by booking status change, not a cron job
 */
async function updateEarningsOnBookingCompletion(bookingId) {
  try {
    const booking = await Booking.findById(bookingId);
    
    if (!booking || booking.status !== 'completed' || booking.paymentStatus !== 'paid') {
      return;
    }
    
    // Calculate earnings (75% of total amount)
    const platformFee = booking.totalAmount * 0.25;
    const companionEarning = booking.totalAmount * 0.75;
    
    // Update booking
    booking.platformFee = platformFee;
    booking.companionEarning = companionEarning;
    await booking.save();
    
    // Update user's earnings
    const companion = await User.findById(booking.companionId);
    if (companion) {
      await companion.addEarnings(companionEarning);
      
      console.log(`✅ Added ₹${companionEarning} earnings for companion ${companion._id}`);
    }
    
  } catch (error) {
    console.error('Update earnings error:', error);
  }
}

/**
 * Start all cron jobs
 */
function startPayoutCronJobs() {
  weeklyPayoutJob.start();
  monthlyPayoutJob.start();
  retryPayoutJob.start();
  
  console.log('✅ Payout cron jobs started');
  console.log('   - Weekly payouts: Every Monday at 9:00 AM');
  console.log('   - Monthly payouts: 1st of every month at 9:00 AM');
  console.log('   - Retry failed payouts: Every hour');
}

/**
 * Stop all cron jobs
 */
function stopPayoutCronJobs() {
  weeklyPayoutJob.stop();
  monthlyPayoutJob.stop();
  retryPayoutJob.stop();
  
  console.log('⏹️  Payout cron jobs stopped');
}

module.exports = {
  startPayoutCronJobs,
  stopPayoutCronJobs,
  updateEarningsOnBookingCompletion
};
