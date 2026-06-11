// utils/fcmHelper.js
// Shared data-only FCM sender.
//
// WHY data-only (no notification payload)?
// When a FCM message contains BOTH notification + data keys, Android OS handles
// display itself when the app is killed — onMessageReceived is never called.
// Sending data-only with android.priority=high always wakes the app and calls
// onMessageReceived, so our custom notification UI is always built.

const admin = require('../config/firebase');
const User  = require('../models/User');

/**
 * Send a high-priority data-only FCM message.
 *
 * @param {string}   userId  - Recipient MongoDB user ID (used for token pruning)
 * @param {string[]} tokens  - FCM registration tokens
 * @param {object}   data    - Key-value payload (all values auto-coerced to strings)
 */
async function sendDataFcm(userId, tokens, data) {
  if (!tokens || tokens.length === 0) return;

  // FCM data payload requires all values to be strings
  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    stringData[k] = v == null ? '' : String(v);
  }

  try {
    const resp = await admin.messaging().sendEachForMulticast({
      data:    stringData,
      tokens,
      android: { priority: 'high' },
    });

    // Prune tokens that FCM rejected (unregistered / invalid)
    if (resp.failureCount > 0) {
      const bad = tokens.filter((_, i) => !resp.responses[i].success);
      if (bad.length > 0) {
        await User.findByIdAndUpdate(userId, { $pull: { fcmTokens: { $in: bad } } });
        console.log('[FCM] Pruned ' + bad.length + ' invalid token(s) for user ' + userId);
      }
    }

    console.log('[FCM] type=' + (stringData.type || '?') +
      ' to=' + userId +
      ' success=' + resp.successCount +
      ' failure=' + resp.failureCount);
  } catch (err) {
    console.error('[FCM] sendDataFcm error:', err.message);
  }
}

module.exports = { sendDataFcm };
