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
 * @param {string[]} tokens  - FCM registration tokens (deduplicated internally)
 * @param {object}   data    - Key-value payload (all values auto-coerced to strings)
 * @returns {Promise<{attempted:number, successCount:number, failureCount:number,
 *                    invalidTokensRemoved:number, delivered:boolean, error:string|null}>}
 *
 * PHASE 2: this used to return undefined and swallow every failure, so callers could
 * not tell delivery apart from a total outage. The Room invitation worker relied on
 * that and burned a 12h user cooldown even when nothing was delivered. It now always
 * resolves with an explicit result and never throws.
 */
async function sendDataFcm(userId, tokens, data) {
  const result = {
    attempted: 0,
    successCount: 0,
    failureCount: 0,
    invalidTokensRemoved: 0,
    delivered: false,
    error: null,
  };

  const uniqueTokens = [...new Set((tokens || []).filter(t => typeof t === 'string' && t.trim()))];
  if (uniqueTokens.length === 0) return result;
  result.attempted = uniqueTokens.length;

  // FCM data payload requires all values to be strings
  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    stringData[k] = v == null ? '' : String(v);
  }

  try {
    const resp = await admin.messaging().sendEachForMulticast({
      data:    stringData,
      tokens:  uniqueTokens,
      android: { priority: 'high' },
    });

    result.successCount = resp.successCount;
    result.failureCount = resp.failureCount;
    result.delivered = resp.successCount > 0;

    // Prune tokens FCM permanently rejected. Only unregistered/invalid-argument
    // errors are pruned — transient errors (unavailable, internal, quota) must NOT
    // cost the user their device registration.
    if (resp.failureCount > 0) {
      const PERMANENT = new Set([
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
        'messaging/invalid-argument',
      ]);
      const bad = uniqueTokens.filter((_, i) => {
        const r = resp.responses[i];
        return !r.success && PERMANENT.has(r.error?.code);
      });
      if (bad.length > 0) {
        // PHASE 2: also prune from fcmDevices[]. Previously only fcmTokens was
        // cleaned, so the Humrah Room invitation worker (which reads tokens from
        // fcmDevices) kept retrying permanently dead tokens forever.
        await User.findByIdAndUpdate(userId, {
          $pull: {
            fcmTokens: { $in: bad },
            fcmDevices: { token: { $in: bad } },
          },
        });
        result.invalidTokensRemoved = bad.length;
        console.log(`[FCM] Pruned ${bad.length} invalid token(s) for user ${userId}`);
      }
    }

    console.log('[FCM] type=' + (stringData.type || '?') +
      ' to=' + userId +
      ' success=' + resp.successCount +
      ' failure=' + resp.failureCount);
  } catch (err) {
    // Total send failure (Firebase not initialised, network, auth, quota).
    result.error = err.message;
    result.failureCount = result.attempted;
    console.error('[FCM] sendDataFcm error:', err.message);
  }

  return result;
}

module.exports = { sendDataFcm };
