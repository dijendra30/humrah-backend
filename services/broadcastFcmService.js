// services/broadcastFcmService.js — FCM sender for broadcast notifications (Phase 1)
// Handles single-user, multi-user, and batch FCM delivery with retry logic.

'use strict';

const admin = require('../config/firebase');
const User  = require('../models/User');

// Configurable batch size for FCM multicast (max 500 per Firebase API)
const FCM_BATCH_SIZE = 500;
const MAX_RETRIES    = 3;

/**
 * Send a broadcast push notification to a single user.
 *
 * @param {string}   userId  - Recipient MongoDB user ID
 * @param {object}   payload - { title, body, data }
 * @returns {Promise<{ success: boolean, fcmMessageId: string|null }>}
 */
async function sendToSingleUser(userId, payload) {
  try {
    const user = await User.findById(userId).select('fcmTokens').lean();
    if (!user?.fcmTokens?.length) {
      return { success: false, fcmMessageId: null, reason: 'no_tokens' };
    }

    const result = await sendToTokens(userId, user.fcmTokens, payload);
    return result;
  } catch (err) {
    console.error('[BroadcastFCM] sendToSingleUser error:', err.message);
    return { success: false, fcmMessageId: null, reason: err.message };
  }
}

/**
 * Send a broadcast push notification to multiple users.
 * Processes users sequentially in batches to avoid overwhelming FCM.
 *
 * @param {Array<{ _id: string, fcmTokens: string[] }>} users - User objects with tokens
 * @param {object} payload - { title, body, data }
 * @returns {Promise<{ successCount: number, failureCount: number, results: Array }>}
 */
async function sendToMultipleUsers(users, payload) {
  let successCount = 0;
  let failureCount = 0;
  const results = [];

  for (const user of users) {
    if (!user.fcmTokens?.length) {
      failureCount++;
      results.push({ userId: user._id, success: false, reason: 'no_tokens' });
      continue;
    }

    const result = await sendToTokens(user._id.toString(), user.fcmTokens, payload);
    if (result.success) {
      successCount++;
    } else {
      failureCount++;
    }
    results.push({ userId: user._id, ...result });
  }

  return { successCount, failureCount, results };
}

/**
 * Send push notification to a set of FCM tokens for a specific user.
 * Handles token batching (max 500 per multicast call), dead token pruning, and retry.
 *
 * @param {string}   userId - For token pruning
 * @param {string[]} tokens - FCM registration tokens
 * @param {object}   payload - { title, body, data }
 * @param {number}   attempt - Current retry attempt (internal)
 * @returns {Promise<{ success: boolean, fcmMessageId: string|null, reason?: string }>}
 */
async function sendToTokens(userId, tokens, payload, attempt = 1) {
  if (!tokens || tokens.length === 0) {
    return { success: false, fcmMessageId: null, reason: 'no_tokens' };
  }

  // Check if Firebase Admin is initialized
  if (!admin.apps.length) {
    console.warn('[BroadcastFCM] Firebase Admin not initialized. Skipping push.');
    return { success: false, fcmMessageId: null, reason: 'firebase_not_initialized' };
  }

  try {
    // FCM data payload requires all values to be strings
    const stringData = {};
    if (payload.data) {
      for (const [k, v] of Object.entries(payload.data)) {
        stringData[k] = v == null ? '' : String(v);
      }
    }

    // Build FCM message — data-only for custom Android notification handling
    const fcmMessage = {
      data: {
        ...stringData,
        title: payload.title || '',
        body:  payload.body  || '',
      },
      tokens: tokens.slice(0, FCM_BATCH_SIZE),
      android: { priority: 'high' },
    };

    const response = await admin.messaging().sendEachForMulticast(fcmMessage);

    // Prune dead/invalid tokens
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
        console.log(`[BroadcastFCM] Pruned ${deadTokens.length} dead token(s) for user ${userId}`);
      }
    }

    const success = response.successCount > 0;
    const fcmMessageId = response.responses.find(r => r.success)?.messageId || null;

    console.log(`[BroadcastFCM] user=${userId} success=${response.successCount} failure=${response.failureCount} attempt=${attempt}`);

    // If all tokens failed and we haven't exhausted retries, retry
    if (!success && attempt < MAX_RETRIES) {
      console.log(`[BroadcastFCM] Retrying user=${userId} attempt=${attempt + 1}/${MAX_RETRIES}`);
      // Short delay before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      return sendToTokens(userId, tokens, payload, attempt + 1);
    }

    return { success, fcmMessageId };
  } catch (err) {
    console.error(`[BroadcastFCM] sendToTokens error (user=${userId}, attempt=${attempt}):`, err.message);

    // Retry on transient errors
    if (attempt < MAX_RETRIES) {
      console.log(`[BroadcastFCM] Retrying user=${userId} attempt=${attempt + 1}/${MAX_RETRIES}`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      return sendToTokens(userId, tokens, payload, attempt + 1);
    }

    return { success: false, fcmMessageId: null, reason: err.message };
  }
}

module.exports = {
  sendToSingleUser,
  sendToMultipleUsers,
  sendToTokens,
};
