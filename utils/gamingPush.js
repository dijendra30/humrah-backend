/**
 * utils/gamingPush.js
 *
 * KEY DESIGN: sends DATA-ONLY messages (no notification:{} field).
 *   - FCM never auto-shows a notification — zero duplicates
 *   - onMessageReceived always fires regardless of app state
 *   - Android shows exactly ONE notification via showGamingNotification()
 *   - recipientUserId in data lets app verify notification is for current user
 */

const mongoose = require("mongoose");

async function sendGamingPush({ recipientId, title, body, data = {} }) {
  // ── 1. Resolve firebase-admin ─────────────────────────────
  let admin;
  try {
    admin = require("firebase-admin");
    admin.app();
  } catch {
    console.warn("[gamingPush] firebase-admin not initialized — skipping push");
    return;
  }

  // ── 2. Fetch recipient FCM tokens ─────────────────────────
  const User = mongoose.model("User");
  const user = await User.findById(recipientId).select("fcmTokens").lean();
  if (!user || !user.fcmTokens || user.fcmTokens.length === 0) return;

  const tokens = user.fcmTokens.filter(Boolean);
  if (tokens.length === 0) return;

  // ── 3. DATA-ONLY message ──────────────────────────────────
  // No notification:{} — prevents Android auto-display AND onMessageReceived double-fire.
  // title + body + recipientUserId are included in data so the app can:
  //   a) display exactly one notification
  //   b) check recipientUserId == SharedPrefs userId before showing
  const stringData = Object.fromEntries(
    Object.entries({ ...data, title, body, recipientUserId: String(recipientId) })
      .map(([k, v]) => [k, String(v)])
  );

  const message = {
    tokens,
    data: stringData,           // ✅ data-only, no notification block
    android: { priority: "high" },
    apns: {
      payload: { aps: { "content-available": 1 } },
      headers: { "apns-priority": "5" },
    },
  };

  // ── 4. Send & remove stale tokens ────────────────────────
  const result = await admin.messaging().sendEachForMulticast(message);

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
    console.log(`[gamingPush] Removed ${staleTokens.length} stale token(s) for ${recipientId}`);
  }

  const successCount = result.responses.filter(r => r.success).length;
  console.log(`[gamingPush] Sent "${title}" → ${successCount}/${tokens.length} tokens delivered`);
}

module.exports = { sendGamingPush };
