'use strict';

const User = require('../models/User');
const { sendDataFcm } = require('../utils/fcmHelper');

/**
 * Maps workflow events to notification content and dispatches them via FCM.
 * @param {string} userId - Recipient User ID
 * @param {object} messageDocument - The FounderMessage document
 * @param {string} eventType - The workflow event (e.g. 'MESSAGE_SUBMITTED', 'MESSAGE_READ_WORKFLOW')
 */
exports.emitFounderEvent = async (userId, messageDocument, eventType) => {
  try {
    const user = await User.findById(userId);
    if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
      return; // No tokens to send to
    }

    let title = '';
    let body = '';

    switch (eventType) {
      case 'MESSAGE_SUBMITTED':
        title = 'Message Sent Successfully';
        body = 'Thank you for reaching out. Your message has been received by the Humrah Founder.';
        break;

      case 'MESSAGE_READ_WORKFLOW':
        title = 'The Humrah Founder has read your message';
        const pref = messageDocument.replyPreference;
        
        if (pref === 'NO_REPLY') {
          body = 'Thank you for sharing your thoughts. As requested, no further reply will be sent, but your message has been personally read and appreciated.';
        } else if (pref === 'EMAIL') {
          body = 'Thank you for reaching out. Your message has been read. A reply will be sent to the email address linked to your Humrah account.';
        } else if (pref === 'FOLLOW_UP') {
          body = 'Your message has been reviewed.'; // Standard read notification
        } else {
          body = 'Your message has been reviewed.';
        }
        break;

      case 'DISCUSSION_READY':
        // Reserved for Phase 5
        return;

      default:
        console.warn(`[FounderNotificationService] Unknown event type: ${eventType}`);
        return;
    }

    // Android client generic handler expects 'type', 'title', 'body'
    const payload = {
      type: 'FOUNDER_NOTIFICATION',
      title,
      body,
      founderMessageId: messageDocument._id.toString()
    };

    // Dispatch asynchronously without awaiting if we don't want to block, 
    // but we are inside an async function so we await it here.
    // The controller won't await emitFounderEvent to prevent blocking.
    await sendDataFcm(user._id.toString(), user.fcmTokens, payload);
  } catch (error) {
    // Notifications must not roll back business logic, just log the error
    console.error(`[FounderNotificationService] Failed to emit event ${eventType}:`, error.message);
  }
};
