// jobs/movieSessionExpiryJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Runs every 60 seconds.
//
// STEP 1: Expire sessions whose showTime + 15 min has passed.
// STEP 2: Send post-session notifications to creators (once per session).
// STEP 3: Expire chats whose showTime + 3 hrs has passed.
//
// Notification messages (per spec):
//   1  participant  → "Your hangout didn't get any joins this time."
//   ≤2 participants → "Only a few people joined this time."
//   ≥3 participants → "Your hangout was active 🎉"
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const MovieSession = require('../models/MovieSession');
const MovieChat    = require('../models/MovieChat');
const { sendPostSessionNotifications } = require('../services/movieSessionService');
const { isAfterEndHour }                = require('../utils/timeLabel');

function startMovieSessionExpiryJob() {
  setInterval(async () => {
    try {
      const now = new Date();

      // ── STEP 1: Find sessions that just expired (not yet marked) ─────────
      const toExpire = await MovieSession.find({
        status:    'active',
        expiresAt: { $lte: now },
      }).lean();

      if (toExpire.length > 0) {
        // Mark all expired in one write
        const ids = toExpire.map(s => s._id);
        await MovieSession.updateMany(
          { _id: { $in: ids } },
          { $set: { status: 'expired' } }
        );
        console.log(`🎬 [expiry] Expired ${toExpire.length} session(s)`);

        // ── STEP 2: Post-session notifications ───────────────────────────
        for (const session of toExpire) {
          try {
            await sendPostSessionNotifications(session);
          } catch (notifyErr) {
            console.error(`[expiry] notification error for ${session._id}: ${notifyErr.message}`);
          }
        }
      }

      // ── STEP 3: Expire chats ─────────────────────────────────────────────
      const chatResult = await MovieChat.updateMany(
        { status: 'active', expiresAt: { $lte: now } },
        { $set: { status: 'expired' } }
      );
      if (chatResult.modifiedCount > 0) {
        console.log(`💬 [expiry] Expired ${chatResult.modifiedCount} chat(s)`);
      }

      // ── STEP 4: After 8 PM — expire ALL today's active sessions ──────────
      // Spec: "If current time >= 8 PM → expire all today's sessions"
      // This catches any sessions that were created earlier today and
      // somehow survived past the 8 PM boundary.
      if (isAfterEndHour()) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const lateResult = await MovieSession.updateMany(
          {
            status:   'active',
            showTime: { $gte: todayStart, $lte: todayEnd },
          },
          { $set: { status: 'expired' } }
        );
        if (lateResult.modifiedCount > 0) {
          console.log(`🌙 [expiry] 8 PM sweep — expired ${lateResult.modifiedCount} today session(s)`);
        }
      }

    } catch (err) {
      console.error('[expiry] job error:', err.message);
    }
  }, 60_000);

  console.log('✅ Movie session expiry job started (60s interval)');
}

module.exports = { startMovieSessionExpiryJob };
