// ==========================================
// services/notificationService.js
// LOCATION-BASED NOTIFICATION MATCHING
// ==========================================

const User = require('../models/User');
const { findNearbyUsers, isUserNearBooking } = require('../utils/distance');

/**
 * Find users to notify about a new random booking
 * 
 * MATCHING CRITERIA:
 * 1. User has recent location (< 24 hours)
 * 2. User is within 50km radius of booking
 * 3. User is not the booking creator
 * 4. User matches booking preferences (optional)
 * 
 * @param {Object} booking - The random booking object
 * @returns {Array} Array of user IDs to notify
 */
async function findUsersToNotify(booking) {
  try {
    console.log(`🔍 Finding users to notify for booking ${booking._id}...`);

    // ✅ STEP 1: Validate booking has location
    if (!booking.lat || !booking.lng) {
      console.log('⚠️ Booking has no location, skipping location-based matching');
      return [];
    }

    // ✅ STEP 2: Find all active users with recent location
    const potentialUsers = await User.find({
      _id: { $ne: booking.userId }, // Exclude booking creator
      status: 'ACTIVE',
      last_known_lat: { $ne: null },
      last_known_lng: { $ne: null },
      last_location_updated_at: {
        $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      }
    }).select('_id first_known_lat last_known_lng fcmTokens');

    console.log(`📊 Found ${potentialUsers.length} users with recent location`);

    // ✅ STEP 3: Filter by distance (50km radius)
    const nearbyUsers = potentialUsers.filter(user => {
      return isUserNearBooking(user, booking, 50); // 50km radius
    });

    console.log(`📍 Found ${nearbyUsers.length} users within 50km`);

    // ✅ STEP 4: Filter users who have FCM tokens (can receive notifications)
    const usersWithFCM = nearbyUsers.filter(user => {
      return user.fcmTokens && user.fcmTokens.length > 0;
    });

    console.log(`📱 Found ${usersWithFCM.length} users with FCM tokens`);

    return usersWithFCM.map(user => user._id);

  } catch (error) {
    console.error('❌ Error finding users to notify:', error);
    return [];
  }
}

/**
 * Send push notifications to nearby users
 * 
 * @param {Object} booking - The random booking
 */
async function notifyNearbyUsers(booking) {
  try {
    const userIds = await findUsersToNotify(booking);

    if (userIds.length === 0) {
      console.log('ℹ️ No nearby users to notify');
      return;
    }

    console.log(`📤 Sending notifications to ${userIds.length} users...`);

    // Get full user details with FCM tokens
    const users = await User.find({
      _id: { $in: userIds }
    }).select('fcmTokens firstName');

    // Send FCM notifications
    const admin = require('firebase-admin');
    const promises = [];

    for (const user of users) {
      if (!user.fcmTokens || user.fcmTokens.length === 0) continue;

      const message = {
        notification: {
          title: '🎉 New Meet Request Nearby!',
          body: `Someone is looking to meet in ${booking.city} on ${booking.date}`
        },
        data: {
          type: 'new_random_booking',
          bookingId: booking._id.toString(),
          city: booking.city,
          date: booking.date,
          time: booking.time
        },
        tokens: user.fcmTokens
      };

      promises.push(
        admin.messaging().sendMulticast(message)
          .then(response => {
            console.log(`✅ Notification sent to ${user.firstName}: ${response.successCount} success`);
            
            // Clean up invalid tokens
            if (response.failureCount > 0) {
              const failedTokens = [];
              response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                  failedTokens.push(user.fcmTokens[idx]);
                }
              });
              
              // Remove invalid tokens
              if (failedTokens.length > 0) {
                user.fcmTokens = user.fcmTokens.filter(
                  token => !failedTokens.includes(token)
                );
                user.save();
              }
            }
          })
          .catch(error => {
            console.error(`❌ Failed to send to ${user.firstName}:`, error);
          })
      );
    }

    await Promise.all(promises);
    console.log(`✅ Notification batch complete`);

  } catch (error) {
    console.error('❌ Error notifying nearby users:', error);
  }
}

/**
 * Get nearby random bookings for a user
 * 
 * Used when showing "Random Meet" screen
 * 
 * @param {String} userId - User ID
 * @param {Number} radiusKm - Search radius in km (default: 50)
 * @returns {Array} Nearby bookings
 */
async function getNearbyRandomBookings(userId, radiusKm = 50) {
  try {
    const user = await User.findById(userId);

    if (!user || !user.hasRecentLocation()) {
      console.log('⚠️ User has no recent location');
      return [];
    }

    const RandomBooking = require('../models/RandomBooking');

    // Find all active random bookings
    const allBookings = await RandomBooking.find({
      userId: { $ne: userId }, // Exclude user's own bookings
      status: 'ACTIVE',
      lat: { $ne: null },
      lng: { $ne: null }
    })
    .populate('userId', 'firstName profilePhoto')
    .sort({ createdAt: -1 });

    // Filter by distance
    const nearbyBookings = allBookings.filter(booking => {
      return isUserNearBooking(user, booking, radiusKm);
    });

    console.log(`📍 Found ${nearbyBookings.length} nearby bookings for user ${userId}`);

    return nearbyBookings;

  } catch (error) {
    console.error('❌ Error getting nearby bookings:', error);
    return [];
  }
}

module.exports = {
  findUsersToNotify,
  notifyNearbyUsers,
  getNearbyRandomBookings
};

// ==========================================
// USAGE IN RANDOM BOOKING CREATION ROUTE
// ==========================================

// routes/randomBookings.js

const { notifyNearbyUsers } = require('../services/notificationService');

router.post('/', authenticate, async (req, res) => {
  try {
    const { city, date, time, lat, lng } = req.body;

    // Validate required fields
    if (!city || !date || !time || !lat || !lng) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Create random booking
    const booking = new RandomBooking({
      userId: req.userId,
      city,
      date,
      time,
      lat,
      lng,
      status: 'ACTIVE'
    });

    await booking.save();

    // ✅ CRITICAL: Notify nearby users
    notifyNearbyUsers(booking).catch(err => {
      console.error('Failed to notify users:', err);
      // Don't fail the request if notifications fail
    });

    res.status(201).json({
      success: true,
      message: 'Random booking created successfully',
      booking
    });

  } catch (error) {
    console.error('Error creating random booking:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});
