// services/push.service.js
const admin = require('../config/firebase');
const User = require('../models/User');

class PushService {
  /**
   * Helper to send notification payload to user's FCM tokens
   * Handles dead token cleanup
   */
  async sendToUser(userId, payload) {
    try {
      const user = await User.findById(userId).select('fcmTokens');
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
        return; // No tokens to send to
      }

      // Check if Firebase Admin is fully initialized
      if (!admin.apps.length) {
        console.warn('[PushService] Firebase Admin not initialized. Skipping push.');
        return;
      }

      const tokens = user.fcmTokens;
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: payload.notification,
        data: payload.data
      });

      // Cleanup dead tokens
      if (response.failureCount > 0) {
        const deadTokens = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errCode = resp.error?.code;
            if (
              errCode === 'messaging/invalid-registration-token' ||
              errCode === 'messaging/registration-token-not-registered'
            ) {
              deadTokens.push(tokens[idx]);
            }
          }
        });

        if (deadTokens.length > 0) {
          await User.findByIdAndUpdate(userId, {
            $pullAll: { fcmTokens: deadTokens }
          });
          console.log(`[PushService] Cleaned up ${deadTokens.length} dead FCM tokens for user ${userId}`);
        }
      }
    } catch (error) {
      console.error('[PushService] Error sending push notification:', error.message);
      // We catch the error so it doesn't crash the calling API
    }
  }

  async sendWarmthNotification(userId, letterId, notificationId) {
    const payload = {
      notification: {
        title: '🤗 Someone sent warmth',
        body: 'Your letter made someone feel less alone.'
      },
      data: {
        type: 'letter_activity',
        activityType: 'warmth',
        letterId: letterId.toString(),
        notificationId: notificationId.toString()
      }
    };
    await this.sendToUser(userId, payload);
  }

  async sendComfortNotification(userId, letterId, notificationId) {
    const payload = {
      notification: {
        title: '❤️ Someone found comfort',
        body: 'Your words helped someone today.'
      },
      data: {
        type: 'letter_activity',
        activityType: 'comfort',
        letterId: letterId.toString(),
        notificationId: notificationId.toString()
      }
    };
    await this.sendToUser(userId, payload);
  }

  async sendNoteNotification(userId, letterId, notificationId, previewText) {
    const preview = previewText && previewText.length > 50 
      ? previewText.substring(0, 47) + '...'
      : previewText;

    const payload = {
      notification: {
        title: '✉️ New note on your letter',
        body: preview || 'Someone left a note on your letter.'
      },
      data: {
        type: 'letter_activity',
        activityType: 'note',
        letterId: letterId.toString(),
        notificationId: notificationId.toString()
      }
    };
    await this.sendToUser(userId, payload);
  }
}

module.exports = new PushService();
