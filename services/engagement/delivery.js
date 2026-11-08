// services/engagement/delivery.js
// -----------------------------------------------------------------------------
// FCM DELIVERY for engagement notifications. Uses the ONE existing Firebase Admin app
// (config/firebase.js); it creates no Firebase configuration of its own.
//
// Message: data-only, android.priority=high (the format every Humrah push uses), plus
//   ttl 12 h        a nudge that arrives days late is worse than none;
//   collapseKey     at most one pending engagement message per device.
// Payload keys: type, title, body, notificationId, category, recipientUserId, v.
// The released Android build shows unknown types through its generic data handler
// (title/body), and drops the push if recipientUserId is not the signed-in account.
//
// Outcome classification (per token, then for the whole message):
//   ACCEPTED   FCM accepted it for at least one device. (Not proof it was displayed.)
//   TRANSIENT  every failure was explicitly temporary (unavailable / internal / quota /
//              rate limit / connection never made / Firebase not initialised) — retry.
//   UNKNOWN    a request may have reached FCM without an answer (timeout) — never retried.
//   PERMANENT  every device failed for a reason a retry cannot fix.
// Only `registration-token-not-registered` and `invalid-registration-token` remove a
// token, and only from this user's own fcmTokens/fcmDevices. Nothing else is deleted.
// -----------------------------------------------------------------------------
'use strict';

const PUSH_TYPE = 'PERSONAL_ENGAGEMENT';
const TTL_MS = 12 * 3600 * 1000;
const COLLAPSE_KEY = 'humrah_engagement';

const INVALID_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
const TRANSIENT = new Set([
  'messaging/unavailable',
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/quota-exceeded',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'app/network-error',
  'FIREBASE_NOT_INITIALISED',
]);
const AMBIGUOUS = new Set(['app/network-timeout']);

const codeOf = err => (err && (err.code || (err.errorInfo && err.errorInfo.code))) || 'unknown';

function classifyCode(code) {
  if (INVALID_TOKEN.has(code)) return 'INVALID_TOKEN';
  if (TRANSIENT.has(code)) return 'TRANSIENT';
  if (AMBIGUOUS.has(code)) return 'UNKNOWN';
  return 'PERMANENT';
}

function buildMessage(tokens, data) {
  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = v == null ? '' : String(v);
  return { data: stringData, tokens, android: { priority: 'high', ttl: TTL_MS, collapseKey: COLLAPSE_KEY } };
}

function buildPayload(doc) {
  return {
    type: PUSH_TYPE,
    title: doc.title,
    body: doc.body,
    notificationId: String(doc._id),
    category: doc.category,
    recipientUserId: String(doc.userId),
    v: '1',
  };
}

/**
 * Overall outcome from per-token results.
 * @param {{success:boolean, code?:string}[]} perToken
 */
function summarise(perToken) {
  const successCount = perToken.filter(r => r.success).length;
  const kinds = perToken.filter(r => !r.success).map(r => classifyCode(r.code));
  let outcome;
  if (successCount > 0) outcome = 'ACCEPTED';
  else if (kinds.includes('UNKNOWN')) outcome = 'UNKNOWN';
  else if (kinds.includes('TRANSIENT')) outcome = 'TRANSIENT';
  else outcome = 'PERMANENT';
  const firstFailure = perToken.find(r => !r.success);
  return {
    outcome,
    successCount,
    failureCount: perToken.length - successCount,
    code: outcome === 'ACCEPTED' ? null : (firstFailure ? String(firstFailure.code || 'unknown').slice(0, 80) : 'NO_TOKENS'),
  };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getMessaging  returns an object with sendEachForMulticast
 * @param {() => boolean} deps.isReady      Firebase initialised?
 * @param {(userId, badTokens) => Promise<number>} deps.pruneTokens
 */
function createSender(deps) {
  return {
    async send(doc, tokens) {
      if (!tokens || tokens.length === 0) return { outcome: 'PERMANENT', successCount: 0, failureCount: 0, code: 'NO_VALID_DEVICE', invalidTokensRemoved: 0 };
      if (!deps.isReady()) return { outcome: 'TRANSIENT', successCount: 0, failureCount: tokens.length, code: 'FIREBASE_NOT_INITIALISED', invalidTokensRemoved: 0 };
      let perToken;
      try {
        const resp = await deps.getMessaging().sendEachForMulticast(buildMessage(tokens, buildPayload(doc)));
        perToken = tokens.map((_, i) => {
          const r = resp.responses[i] || {};
          return r.success ? { success: true } : { success: false, code: codeOf(r.error) };
        });
      } catch (err) {
        // The whole call failed before per-token results existed.
        const code = codeOf(err);
        const kind = classifyCode(code);
        return {
          outcome: kind === 'INVALID_TOKEN' ? 'PERMANENT' : kind,
          successCount: 0, failureCount: tokens.length, code: String(code).slice(0, 80), invalidTokensRemoved: 0,
        };
      }
      const bad = tokens.filter((_, i) => !perToken[i].success && INVALID_TOKEN.has(perToken[i].code));
      let invalidTokensRemoved = 0;
      if (bad.length) {
        try { invalidTokensRemoved = await deps.pruneTokens(doc.userId, bad); } catch (_) { /* pruning is best effort */ }
      }
      return { ...summarise(perToken), invalidTokensRemoved };
    },
  };
}

/** The production sender: the shared Firebase Admin app and the user's own token lists. */
function defaultSender() {
  const admin = require('../../config/firebase');
  const User = require('../../models/User');
  return createSender({
    isReady: () => admin.apps.length > 0,
    getMessaging: () => admin.messaging(),
    pruneTokens: async (userId, bad) => {
      await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { $in: bad }, fcmDevices: { token: { $in: bad } } } });
      return bad.length;
    },
  });
}

module.exports = {
  PUSH_TYPE, TTL_MS, COLLAPSE_KEY,
  createSender, defaultSender, buildPayload, buildMessage, classifyCode, summarise,
};
