// backend/utils/broadcastNotification.js - Complete FCM Notification System

const User = require('../models/User');
const admin = require('../config/firebase'); // ✅ Import Firebase Admin

/**
 * Broadcast new random booking notification to eligible users in same city
 * 
 * @param {Object} booking - The newly created booking
 * @param {Object} creator - The user who created the booking
 * @returns {Object} - Notification result with count sent
 */
async function broadcastNewBooking(booking, creator) {
  try {
    console.log(`📢 Broadcasting new booking notification...`);
    console.log(`   Booking ID: ${booking._id}`);
    console.log(`   City: ${booking.city}`);
    console.log(`   Creator: ${creator.fullName}`);

    // ==================== STEP 1: FIND ELIGIBLE USERS ====================
    
    // Find users in the same city (exclude creator)
    const eligibleUsers = await User.find({
      _id: { $ne: creator._id }, // Exclude creator
      'questionnaire.city': booking.city, // Same city
      status: 'ACTIVE', // Active accounts only
      fcmTokens: { $exists: true, $ne: [] } // Has FCM tokens
    }).select('_id firstName lastName fcmTokens');

    if (!eligibleUsers || eligibleUsers.length === 0) {
      console.log(`⚠️  No eligible users found in ${booking.city}`);
      return {
        success: true,
        sentCount: 0,
        message: 'No eligible users in this city'
      };
    }

    console.log(`✅ Found ${eligibleUsers.length} eligible users in ${booking.city}`);

    // ==================== STEP 2: COLLECT FCM TOKENS ====================
    
    const fcmTokens = [];
    eligibleUsers.forEach(user => {
      if (user.fcmTokens && Array.isArray(user.fcmTokens)) {
        fcmTokens.push(...user.fcmTokens);
      }
    });

    if (fcmTokens.length === 0) {
      console.log(`⚠️  No FCM tokens found for eligible users`);
      return {
        success: true,
        sentCount: 0,
        message: 'No FCM tokens available'
      };
    }

    console.log(`📱 Collected ${fcmTokens.length} FCM tokens`);

    // ==================== STEP 3: PREPARE NOTIFICATION DATA ====================
    
    const notificationData = {
      title: '🎲 New Random Hangout!',
      body: `${creator.firstName} wants to hangout at ${booking.destination} in ${booking.city}`,
      data: {
        type: 'NEW_RANDOM_BOOKING',
        bookingId: booking._id.toString(),
        creatorId: creator._id.toString(),
        city: booking.city,
        destination: booking.destination,
        activityType: booking.activityType,
        date: booking.date,
        timeRange: booking.timeRange
      }
    };

    console.log(`📦 Notification data prepared:`);
    console.log(`   Title: ${notificationData.title}`);
    console.log(`   Body: ${notificationData.body}`);

    // ==================== STEP 4: SEND FCM NOTIFICATION ====================
    
    let sentCount = 0;
    
    try {
      // ✅ SEND MULTICAST MESSAGE TO ALL TOKENS
      const message = {
        notification: {
          title: notificationData.title,
          body: notificationData.body
        },
        data: notificationData.data,
        tokens: fcmTokens,
        // Optional: Configure Android/iOS specific settings
        android: {
          priority: 'high',
          notification: {
            channelId: 'humrah_notifications',
            sound: 'default',
            clickAction: 'OPEN_RANDOM_BOOKING'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      
      sentCount = response.successCount;
      
      console.log(`✅ FCM Notification sent successfully`);
      console.log(`   Success: ${response.successCount}/${fcmTokens.length}`);
      console.log(`   Failed: ${response.failureCount}`);

      // ✅ HANDLE FAILED TOKENS (remove invalid tokens from database)
      if (response.failureCount > 0) {
        console.log(`⚠️  Some notifications failed. Cleaning up invalid tokens...`);
        
        const failedTokens = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            failedTokens.push(fcmTokens[idx]);
            console.log(`   Failed: ${resp.error?.message || 'Unknown error'}`);
          }
        });

        // Remove invalid tokens from users
        if (failedTokens.length > 0) {
          await User.updateMany(
            { fcmTokens: { $in: failedTokens } },
            { $pull: { fcmTokens: { $in: failedTokens } } }
          );
          console.log(`🧹 Cleaned up ${failedTokens.length} invalid tokens`);
        }
      }

    } catch (fcmError) {
      console.error('❌ FCM send error:', fcmError);
      return {
        success: false,
        sentCount: 0,
        error: fcmError.message
      };
    }

    // ==================== STEP 5: RETURN RESULT ====================
    
    return {
      success: true,
      sentCount,
      totalUsers: eligibleUsers.length,
      totalTokens: fcmTokens.length,
      city: booking.city,
      message: `Notification sent to ${sentCount} devices`
    };

  } catch (error) {
    console.error('❌ Broadcast notification error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Send booking accepted notification to creator
 * 
 * @param {Object} booking - The accepted booking
 * @param {Object} acceptor - The user who accepted
 * @param {String} chatId - The created chat ID
 */
async function notifyBookingAccepted(booking, acceptor, chatId) {
  try {
    console.log(`📢 Sending booking accepted notification...`);

    // Get creator's FCM tokens
    const creator = await User.findById(booking.createdBy).select('fcmTokens firstName');
    
    if (!creator || !creator.fcmTokens || creator.fcmTokens.length === 0) {
      console.log(`⚠️  Creator has no FCM tokens`);
      return { success: false, message: 'No FCM tokens' };
    }

    const notificationData = {
      title: '🎉 Booking Accepted!',
      body: `${acceptor.firstName} accepted your booking! Start chatting now.`,
      data: {
        type: 'BOOKING_ACCEPTED',
        bookingId: booking._id.toString(),
        acceptedUserId: acceptor._id.toString(),
        chatId: chatId
      }
    };

    const message = {
      notification: {
        title: notificationData.title,
        body: notificationData.body
      },
      data: notificationData.data,
      tokens: creator.fcmTokens,
      android: {
        priority: 'high',
        notification: {
          channelId: 'humrah_notifications',
          sound: 'default'
        }
      }
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Booking accepted notification sent: ${response.successCount}/${creator.fcmTokens.length}`);

    return {
      success: true,
      sentCount: response.successCount
    };

  } catch (error) {
    console.error('❌ Notify booking accepted error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Send new chat message notification
 * 
 * @param {Object} chat - The chat
 * @param {Object} message - The new message
 * @param {Object} sender - The message sender
 */
async function notifyNewChatMessage(chat, message, sender) {
  try {
    console.log(`📢 Sending new message notification...`);

    // Get recipient (the other participant)
    const recipientId = chat.participants.find(p => p.toString() !== sender._id.toString());
    
    if (!recipientId) {
      console.log(`⚠️  No recipient found`);
      return { success: false };
    }

    const recipient = await User.findById(recipientId).select('fcmTokens firstName');
    
    if (!recipient || !recipient.fcmTokens || recipient.fcmTokens.length === 0) {
      console.log(`⚠️  Recipient has no FCM tokens`);
      return { success: false };
    }

    const notificationData = {
      title: `💬 ${sender.firstName}`,
      body: message.content.substring(0, 100), // Truncate long messages
      data: {
        type: 'NEW_MESSAGE',
        chatId: chat._id.toString(),
        senderId: sender._id.toString(),
        messageId: message._id.toString()
      }
    };

    const fcmMessage = {
      notification: {
        title: notificationData.title,
        body: notificationData.body
      },
      data: notificationData.data,
      tokens: recipient.fcmTokens,
      android: {
        priority: 'high',
        notification: {
          channelId: 'humrah_notifications',
          sound: 'default'
        }
      }
    };

    const response = await admin.messaging().sendEachForMulticast(fcmMessage);

    console.log(`✅ Message notification sent: ${response.successCount}/${recipient.fcmTokens.length}`);

    return {
      success: true,
      sentCount: response.successCount
    };

  } catch (error) {
    console.error('❌ Notify new message error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  broadcastNewBooking,
  notifyBookingAccepted,
  notifyNewChatMessage
};
