// utils/progressiveMatching.js - PROGRESSIVE DISTANCE-BASED MATCHING

const RandomBooking = require('../models/RandomBooking');
const User = require('../models/User');
const admin = require('../config/firebase');

/**
 * Calculate distance between two GPS coordinates
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return value * Math.PI / 180;
}

/**
 * Progressive Distance-Based Matching
 * 
 * Phase 1: 0-5km radius, wait 3-5 minutes
 * Phase 2: 5-10km radius, wait 3 minutes
 * Phase 3: 10-15km radius, final attempt
 * 
 * If no match → mark EXPIRED
 */
async function startProgressiveMatching(bookingId) {
  console.log('');
  console.log('🎯 PROGRESSIVE MATCHING STARTED');
  console.log('   Booking ID:', bookingId);

  try {
    const booking = await RandomBooking.findById(bookingId);
    
    if (!booking) {
      console.error('❌ Booking not found');
      return;
    }

    // Phase 1: 5km radius, wait 4 minutes
    setTimeout(async () => {
      await runMatchingPhase(bookingId, 1, 5);
    }, 4 * 60 * 1000); // 4 minutes

    // Phase 2: 10km radius, wait another 3 minutes
    setTimeout(async () => {
      await runMatchingPhase(bookingId, 2, 10);
    }, 7 * 60 * 1000); // 7 minutes total

    // Phase 3: 15km radius, final attempt
    setTimeout(async () => {
      await runMatchingPhase(bookingId, 3, 15);
    }, 10 * 60 * 1000); // 10 minutes total

    // Final check: Mark as EXPIRED if still pending
    setTimeout(async () => {
      await finalExpireCheck(bookingId);
    }, 11 * 60 * 1000); // 11 minutes total

  } catch (error) {
    console.error('❌ Progressive matching error:', error);
  }
}

/**
 * Run a specific matching phase
 */
async function runMatchingPhase(bookingId, phase, radius) {
  try {
    console.log('');
    console.log(`🔍 PHASE ${phase}: Radius ${radius}km`);
    
    const booking = await RandomBooking.findById(bookingId);
    
    if (!booking) {
      console.log('   Booking not found');
      return;
    }

    if (booking.status !== 'PENDING') {
      console.log(`   Booking already ${booking.status} - skipping phase`);
      return;
    }

    // Find eligible users within radius
    const eligibleUsers = await findEligibleUsers(
      booking.lat,
      booking.lng,
      radius,
      booking.initiatorId,
      phase
    );

    console.log(`   Found ${eligibleUsers.length} eligible users`);

    if (eligibleUsers.length === 0) {
      console.log(`   No users found in ${radius}km radius`);
      return;
    }

    // Send notifications to eligible users
    await sendProximityNotifications(booking, eligibleUsers, radius);

    console.log(`   ✅ Phase ${phase} complete`);
  } catch (error) {
    console.error(`   ❌ Phase ${phase} error:`, error);
  }
}

/**
 * Find eligible users within radius
 */
async function findEligibleUsers(lat, lng, radius, excludeUserId, phase) {
  try {
    // Query criteria changes per phase
    const criteria = {
      _id: { $ne: excludeUserId },
      isVerified: true,
      account_status: 'ACTIVE',
      fcmTokens: { $exists: true, $ne: [] },
      last_known_lat: { $exists: true },
      last_known_lng: { $exists: true }
    };

    // Phase 1: Only users who updated location recently (active users)
    if (phase === 1) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      criteria.last_location_updated_at = { $gte: oneHourAgo };
    }

    // Phase 2: Expand to users active today
    if (phase === 2) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      criteria.last_location_updated_at = { $gte: todayStart };
    }

    // Phase 3: All verified users with GPS

    const users = await User.find(criteria)
      .select('_id firstName lastName fcmTokens last_known_lat last_known_lng behaviorMetrics')
      .lean();

    // Filter by distance
    const nearbyUsers = users
      .map(user => {
        const distance = calculateDistance(
          lat, lng,
          user.last_known_lat, user.last_known_lng
        );
        return { ...user, distance };
      })
      .filter(user => user.distance <= radius)
      .filter(user => {
        // Exclude users with high no-show rate (silent throttling)
        const noShowRate = (user.behaviorMetrics?.noShowCount || 0) / 
                          Math.max((user.behaviorMetrics?.bookingsAccepted || 1), 1);
        return noShowRate < 0.3; // Less than 30% no-show rate
      })
      .sort((a, b) => a.distance - b.distance);

    return nearbyUsers;
  } catch (error) {
    console.error('Find eligible users error:', error);
    return [];
  }
}

/**
 * Send proximity-based notifications
 */
async function sendProximityNotifications(booking, eligibleUsers, radius) {
  try {
    const fcmTokens = [];
    
    eligibleUsers.forEach(user => {
      if (user.fcmTokens && Array.isArray(user.fcmTokens)) {
        fcmTokens.push(...user.fcmTokens);
      }
    });

    if (fcmTokens.length === 0) {
      console.log('   No FCM tokens found');
      return;
    }

    console.log(`   📱 Sending to ${fcmTokens.length} tokens`);

    // Format start time
    const startTime = new Date(booking.startTime);
    const timeStr = startTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    // Notification content (SAFE - no personal info)
    const notificationData = {
      title: 'Public meet available nearby',
      body: `${booking.activityType.toLowerCase()} at ${timeStr} today`,
      data: {
        type: 'NEW_RANDOM_BOOKING',
        bookingId: booking._id.toString(),
        city: booking.city,
        activityType: booking.activityType,
        locationCategory: booking.locationCategory || 'Public Place',
        startTime: booking.startTime.toISOString(),
        radius: radius.toString()
      }
    };

    const message = {
      notification: {
        title: notificationData.title,
        body: notificationData.body
      },
      data: notificationData.data,
      tokens: fcmTokens,
      android: {
        priority: 'high',
        notification: {
          channelId: 'humrah_notifications',
          sound: 'default'
        }
      }
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    
    console.log(`   ✅ Sent: ${response.successCount}/${fcmTokens.length}`);
    console.log(`   ❌ Failed: ${response.failureCount}`);

    // Clean up invalid tokens
    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(fcmTokens[idx]);
        }
      });

      if (failedTokens.length > 0) {
        await User.updateMany(
          { fcmTokens: { $in: failedTokens } },
          { $pull: { fcmTokens: { $in: failedTokens } } }
        );
        console.log(`   🧹 Cleaned ${failedTokens.length} invalid tokens`);
      }
    }

    return {
      success: true,
      sentCount: response.successCount,
      totalUsers: eligibleUsers.length
    };
  } catch (error) {
    console.error('Send proximity notifications error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Final check: Mark booking as EXPIRED if still pending
 */
async function finalExpireCheck(bookingId) {
  try {
    console.log('');
    console.log('⏰ FINAL EXPIRE CHECK');
    console.log('   Booking ID:', bookingId);

    const booking = await RandomBooking.findById(bookingId);
    
    if (!booking) {
      console.log('   Booking not found');
      return;
    }

    if (booking.status === 'PENDING') {
      booking.status = 'EXPIRED';
      booking.expiredAt = new Date();
      await booking.save();

      console.log('   ❌ Booking EXPIRED (no matches found)');

      // Notify creator
      const creator = await User.findById(booking.initiatorId)
        .select('fcmTokens firstName');

      if (creator && creator.fcmTokens && creator.fcmTokens.length > 0) {
        const message = {
          notification: {
            title: 'No matches found',
            body: 'Unfortunately, no nearby users were available for your Random Meet request.'
          },
          data: {
            type: 'BOOKING_EXPIRED',
            bookingId: booking._id.toString()
          },
          tokens: creator.fcmTokens
        };

        await admin.messaging().sendEachForMulticast(message);
        console.log('   📢 Expiry notification sent to creator');
      }
    } else {
      console.log(`   ✅ Booking is ${booking.status} - no action needed`);
    }
  } catch (error) {
    console.error('Final expire check error:', error);
  }
}

/**
 * Notify both users when booking is matched
 */
async function notifyBookingMatched(booking, acceptor) {
  try {
    console.log('📢 NOTIFY BOOKING MATCHED');

    // Notify initiator
    const initiator = await User.findById(booking.initiatorId)
      .select('fcmTokens firstName');

    if (initiator && initiator.fcmTokens && initiator.fcmTokens.length > 0) {
      const message = {
        notification: {
          title: '🎉 Match confirmed!',
          body: `${acceptor.firstName} accepted your Random Meet request. Chat is now open.`
        },
        data: {
          type: 'BOOKING_MATCHED',
          bookingId: booking._id.toString(),
          chatId: booking.chatId.toString(),
          acceptorId: acceptor._id.toString()
        },
        tokens: initiator.fcmTokens
      };

      await admin.messaging().sendEachForMulticast(message);
      console.log('   ✅ Initiator notified');
    }

    console.log('   ✅ Match notifications complete');
  } catch (error) {
    console.error('Notify booking matched error:', error);
  }
}

module.exports = {
  startProgressiveMatching,
  notifyBookingMatched,
  calculateDistance
};
