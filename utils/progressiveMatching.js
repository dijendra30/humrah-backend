// utils/progressiveMatching.js - PROGRESSIVE DISTANCE-BASED MATCHING

const RandomBooking = require('../models/RandomBooking');
const User = require('../models/User');
const admin = require('../config/firebase');

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
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

    setTimeout(async () => { await runMatchingPhase(bookingId, 1, 5); }, 4 * 60 * 1000);
    setTimeout(async () => { await runMatchingPhase(bookingId, 2, 10); }, 7 * 60 * 1000);
    setTimeout(async () => { await runMatchingPhase(bookingId, 3, 15); }, 10 * 60 * 1000);
    setTimeout(async () => { await finalExpireCheck(bookingId); }, 11 * 60 * 1000);

  } catch (error) {
    console.error('❌ Progressive matching error:', error);
  }
}

async function runMatchingPhase(bookingId, phase, radius) {
  try {
    console.log('');
    console.log(`🔍 PHASE ${phase}: Radius ${radius}km`);

    const booking = await RandomBooking.findById(bookingId);
    if (!booking) { console.log('   Booking not found'); return; }
    if (booking.status !== 'PENDING') { console.log(`   Booking already ${booking.status} - skipping`); return; }

    const eligibleUsers = await findEligibleUsers(booking.lat, booking.lng, radius, booking.initiatorId, phase);
    console.log(`   Found ${eligibleUsers.length} eligible users`);

    if (eligibleUsers.length === 0) { console.log(`   No users found in ${radius}km radius`); return; }

    await sendProximityNotifications(booking, eligibleUsers, radius);
    console.log(`   ✅ Phase ${phase} complete`);
  } catch (error) {
    console.error(`   ❌ Phase ${phase} error:`, error);
  }
}

/**
 * ✅ FIXED: Find eligible users within radius
 *
 * BUG: Was using `isVerified: true` but the User model field is `verified: true`
 * This caused NO users to match, so nobody got proximity notifications,
 * and the booking always expired with "no matches found".
 */
async function findEligibleUsers(lat, lng, radius, excludeUserId, phase) {
  try {
    const criteria = {
      _id: { $ne: excludeUserId },
      verified: true,           // ✅ FIXED: was `isVerified` — correct field is `verified`
      status: 'ACTIVE',         // ✅ FIXED: was `account_status` — correct field is `status`
      fcmTokens: { $exists: true, $ne: [] },
      last_known_lat: { $exists: true, $ne: null },
      last_known_lng: { $exists: true, $ne: null }
    };

    if (phase === 1) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      criteria.last_location_updated_at = { $gte: oneHourAgo };
    }

    if (phase === 2) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      criteria.last_location_updated_at = { $gte: todayStart };
    }

    // Phase 3: All verified users with GPS (no time filter)

    const users = await User.find(criteria)
      .select('_id firstName lastName fcmTokens last_known_lat last_known_lng behaviorMetrics')
      .lean();

    const nearbyUsers = users
      .map(user => {
        const distance = calculateDistance(lat, lng, user.last_known_lat, user.last_known_lng);
        return { ...user, distance };
      })
      .filter(user => user.distance <= radius)
      .filter(user => {
        const noShowRate = (user.behaviorMetrics?.noShowCount || 0) /
                          Math.max((user.behaviorMetrics?.bookingsAccepted || 1), 1);
        return noShowRate < 0.3;
      })
      .sort((a, b) => a.distance - b.distance);

    return nearbyUsers;
  } catch (error) {
    console.error('Find eligible users error:', error);
    return [];
  }
}

async function sendProximityNotifications(booking, eligibleUsers, radius) {
  try {
    const fcmTokens = [];
    eligibleUsers.forEach(user => {
      if (user.fcmTokens && Array.isArray(user.fcmTokens)) {
        fcmTokens.push(...user.fcmTokens);
      }
    });

    if (fcmTokens.length === 0) { console.log('   No FCM tokens found'); return; }

    console.log(`   📱 Sending to ${fcmTokens.length} tokens`);

    const startTime = new Date(booking.startTime);
    const timeStr = startTime.toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'  // ✅ Show IST time in notification
    });

    const message = {
      notification: {
        title: 'Public meet available nearby',
        body: `${booking.activityType.toLowerCase()} at ${timeStr} today`
      },
      data: {
        type: 'NEW_RANDOM_BOOKING',
        bookingId: booking._id.toString(),
        city: booking.city,
        activityType: booking.activityType,
        locationCategory: booking.locationCategory || 'Public Place',
        startTime: booking.startTime.toISOString(),
        radius: radius.toString()
      },
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

    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) failedTokens.push(fcmTokens[idx]);
      });

      if (failedTokens.length > 0) {
        await User.updateMany(
          { fcmTokens: { $in: failedTokens } },
          { $pull: { fcmTokens: { $in: failedTokens } } }
        );
        console.log(`   🧹 Cleaned ${failedTokens.length} invalid tokens`);
      }
    }

    return { success: true, sentCount: response.successCount, totalUsers: eligibleUsers.length };
  } catch (error) {
    console.error('Send proximity notifications error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * ✅ FIXED: Final check - notify ONLY the creator (initiator), not other users.
 *
 * The original code was correct in only notifying the creator.
 * But the bug was in findEligibleUsers using wrong field names,
 * which caused all phase notifications to fail silently,
 * making it look like the "no match" notification was going to wrong users.
 * With the field name fixes above, only the initiator gets the expiry notification.
 */
async function finalExpireCheck(bookingId) {
  try {
    console.log('');
    console.log('⏰ FINAL EXPIRE CHECK');
    console.log('   Booking ID:', bookingId);

    const booking = await RandomBooking.findById(bookingId);
    if (!booking) { console.log('   Booking not found'); return; }

    if (booking.status === 'PENDING') {
      booking.status = 'EXPIRED';
      booking.expiredAt = new Date();
      await booking.save();

      console.log('   ❌ Booking EXPIRED (no matches found)');

      // ✅ Notify ONLY the creator (initiatorId) — not anyone else
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
          tokens: creator.fcmTokens  // ✅ Only sent to creator's tokens
        };

        await admin.messaging().sendEachForMulticast(message);
        console.log(`   📢 Expiry notification sent ONLY to creator: ${creator._id}`);
      }
    } else {
      console.log(`   ✅ Booking is ${booking.status} - no action needed`);
    }
  } catch (error) {
    console.error('Final expire check error:', error);
  }
}

async function notifyBookingMatched(booking, acceptor) {
  try {
    console.log('📢 NOTIFY BOOKING MATCHED');

    const initiator = await User.findById(booking.initiatorId).select('fcmTokens firstName');

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
      console.log('   ✅ Initiator notified of match');
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
