/**
 * utils/gamingPush.js
 *
 * Sends Firebase Cloud Messaging push notifications for gaming session events.
 *
 * Uses the app's existing firebase-admin setup (initialized once in server.js).
 * Falls back gracefully if firebase-admin is not yet initialized.
 *
 * Usage:
 *   const { sendGamingPush } = require("../utils/gamingPush");
 *
 *   await sendGamingPush({
 *     recipientId: session.creatorId.toString(),
 *     title:       "BGMI Session",
 *     body:        "Arjun joined your BGMI session! 🎮",
 *     data:        { type: "PLAYER_JOINED", sessionId: "abc123" },
 *   });
 */

const mongoose = require("mongoose");

/**
 * Send a push notification to all FCM tokens registered for a user.
 *
 * @param {Object} opts
 * @param {string}  opts.recipientId   - MongoDB User _id string
 * @param {string}  opts.title         - Notification title
 * @param {string}  opts.body          - Notification body
 * @param {Object}  [opts.data]        - Extra key-value payload (string values only)
 */
async function sendGamingPush({ recipientId, title, body, data = {} }) {
  // ── 1. Resolve firebase-admin app ──────────────────────────
  let admin;
  try {
    admin = require("firebase-admin");
    // If getApp() throws, firebase-admin hasn't been initialized yet
    admin.app();
  } catch {
    console.warn("[gamingPush] firebase-admin not initialized — skipping push");
    return;
  }

  // ── 2. Fetch recipient's FCM tokens ────────────────────────
  const User = mongoose.model("User");
  const user = await User.findById(recipientId).select("fcmTokens").lean();
  if (!user || !user.fcmTokens || user.fcmTokens.length === 0) return;

  const tokens = user.fcmTokens.filter(Boolean);
  if (tokens.length === 0) return;

  // ── 3. Build FCM multicast message ────────────────────────
  // Stringify all data values (FCM requires string-only maps)
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const message = {
    tokens,
    notification: { title, body },
    data: stringData,
    android: {
      priority: "high",
      notification: {
        channelId: "gaming_sessions",   // must match Android channel ID
        sound:     "default",
      },
    },
    apns: {
      payload: {
        aps: { sound: "default", badge: 1 },
      },
    },
  };

  // ── 4. Send & clean up stale tokens ───────────────────────
  const result = await admin.messaging().sendEachForMulticast(message);

  // Remove tokens that are no longer valid
  const staleTokens = [];
  result.responses.forEach((resp, idx) => {
    if (!resp.success) {
      const code = resp.error?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        staleTokens.push(tokens[idx]);
      }
    }
  });

  if (staleTokens.length > 0) {
    await User.findByIdAndUpdate(recipientId, {
      $pull: { fcmTokens: { $in: staleTokens } },
    });
  }

  const successCount = result.responses.filter(r => r.success).length;
  console.log(`[gamingPush] Sent "${title}" → ${successCount}/${tokens.length} tokens delivered`);
}

module.exports = { sendGamingPush };
