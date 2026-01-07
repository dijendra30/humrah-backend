// utils/broadcastNotification.js - SAME LOGIC AS SPOTLIGHT
const User = require('../models/User');

/**
 * Broadcast notification to eligible users
 * Uses EXACT same logic as Spotlight (city filtering)
 * 
 * @param {String} bookingCity - The city from booking.city
 * @param {String} initiatorId - The user who created booking (exclude them)
 * @param {Object} notificationData - Data to send in notification
 */
async function broadcastBookingNotification(bookingCity, initiatorId, notificationData) {
  try {
    console.log('📢 Broadcasting booking notification:', {
      city: bookingCity,
      initiatorId,
      notification: notificationData.title
    });

    // 1. ✅ CHECK: If no city, can't broadcast
    if (!bookingCity) {
      console.log('⚠️ No city provided, skipping broadcast');
      return {
        success: false,
        notified: 0,
        message: 'No city provided'
      };
    }

    // 2. Fetch ALL users (we'll filter by city in JS - same as Spotlight)
    const query = {
      _id: { $ne: initiatorId },  // Exclude booking creator
      role: 'USER'                 // Only users
    };

    console.log('🔎 Query:', JSON.stringify(query, null, 2));

    const allUsers = await User.find(query)
      .select('_id firstName lastName questionnaire fcmTokens')
      .limit(500);  // Reasonable limit

    console.log(`📊 Found ${allUsers.length} total users`);

    // 3. ✅ FILTER: Only users in SAME CITY (case-insensitive)
    // EXACT SAME LOGIC AS SPOTLIGHT
    const sameCityUsers = allUsers.filter(user => {
      const userCity = user.questionnaire?.city;
      return userCity && 
             userCity.toLowerCase().trim() === bookingCity.toLowerCase().trim();
    });

    console.log(`🏙️ Filtered to ${sameCityUsers.length} users in ${bookingCity}`);

    // 4. ✅ CHECK: If no users in same city, nothing to broadcast
    if (sameCityUsers.length === 0) {
      console.log(`⚠️ No users found in ${bookingCity}`);
      return {
        success: true,
        notified: 0,
        message: `No users in ${bookingCity} to notify`
      };
    }

    // 5. Collect FCM tokens (users who have the app installed)
    const fcmTokens = [];
    const notifiedUsers = [];

    sameCityUsers.forEach(user => {
      if (user.fcmTokens && user.fcmTokens.length > 0) {
        fcmTokens.push(...user.fcmTokens);
        notifiedUsers.push({
          id: user._id,
          name: `${user.firstName} ${user.lastName}`,
          city: user.questionnaire?.city
        });
      }
    });

    console.log(`📱 Collected ${fcmTokens.length} FCM tokens from ${notifiedUsers.length} users`);

    // 6. Send push notifications (if FCM is configured)
    let sentCount = 0;
    
    if (fcmTokens.length > 0) {
      try {
        // TODO: Replace with your actual FCM implementation
        // const admin = require('firebase-admin');
        // const message = {
        //   notification: {
        //     title: notificationData.title,
        //     body: notificationData.body,
        //     imageUrl: notificationData.image
        //   },
        //   data: notificationData.data || {},
        //   tokens: fcmTokens
        // };
        // const response = await admin.messaging().sendMulticast(message);
        // sentCount = response.successCount;

        // For now, just log (implement FCM later)
        console.log('📤 Would send notifications to:', notifiedUsers.length, 'users');
        console.log('📋 Notification data:', notificationData);
        sentCount = notifiedUsers.length;

      } catch (fcmError) {
        console.error('❌ FCM send error:', fcmError);
      }
    }

    // 7. Log results
    console.log('✅ Broadcast complete:', {
      totalUsers: allUsers.length,
      sameCityUsers: sameCityUsers.length,
      withFCM: notifiedUsers.length,
      sentCount
    });

    console.log('👥 Notified users:', notifiedUsers.map(u => ({ 
      name: u.name,
      city: u.city
    })));

    return {
      success: true,
      notified: sentCount,
      eligibleUsers: sameCityUsers.length,
      message: `Notified ${sentCount} users in ${bookingCity}`
    };

  } catch (error) {
    console.error('❌ Broadcast error:', error);
    return {
      success: false,
      notified: 0,
      error: error.message
    };
  }
}

/**
 * Broadcast when new random booking is created
 */
async function broadcastNewBooking(booking) {
  const notificationData = {
    title: '🎲 New Random Hangout!',
    body: `Someone wants to hangout in ${booking.city}. Check it out!`,
    image: null,
    data: {
      type: 'NEW_RANDOM_BOOKING',
      bookingId: booking._id.toString(),
      city: booking.city,
      area: booking.area,
      destination: booking.destination,
      activityType: booking.activityType
    }
  };

  return broadcastBookingNotification(
    booking.city,
    booking.initiatorId.toString(),
    notificationData
  );
}

/**
 * Broadcast when booking is accepted (notify initiator)
 */
async function notifyBookingAccepted(booking, acceptedUser) {
  try {
    const initiator = await User.findById(booking.initiatorId)
      .select('fcmTokens firstName lastName');

    if (!initiator || !initiator.fcmTokens || initiator.fcmTokens.length === 0) {
      console.log('⚠️ Initiator has no FCM tokens');
      return { success: false, notified: 0 };
    }

    const notificationData = {
      title: '🎉 Booking Accepted!',
      body: `${acceptedUser.firstName} accepted your booking! Start chatting now.`,
      image: acceptedUser.profilePhoto || null,
      data: {
        type: 'BOOKING_ACCEPTED',
        bookingId: booking._id.toString(),
        chatId: booking.chatId?.toString(),
        acceptedUserId: acceptedUser._id.toString()
      }
    };

    // TODO: Send FCM to initiator
    console.log('📤 Would notify initiator:', {
      initiatorId: initiator._id,
      notification: notificationData
    });

    return {
      success: true,
      notified: 1,
      message: 'Initiator notified'
    };

  } catch (error) {
    console.error('❌ Notify accepted error:', error);
    return { success: false, notified: 0 };
  }
}

module.exports = {
  broadcastBookingNotification,
  broadcastNewBooking,
  notifyBookingAccepted
};
