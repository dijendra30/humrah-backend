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

      // ── STEP 4: After 8 PM IST — expire ALL today’s active sessions ────────────
      // Catches any sessions that were created earlier today and
      // survived past the 8 PM IST boundary.
      // Use IST date bounds: today IST start = yesterday UTC 18:30,
      // today IST end = today UTC 18:29:59.
      if (isAfterEndHour()) {
        const IST_OFFSET_MS  = 5.5 * 60 * 60 * 1000;
        const nowIST         = new Date(now.getTime() + IST_OFFSET_MS);
        const todayISTStr    = nowIST.toISOString().slice(0, 10); // YYYY-MM-DD in IST

        const lateResult = await MovieSession.updateMany(
          {
            status:            'active',
            isSystemGenerated: true,
            date:              todayISTStr,  // match the IST date string stored on session
          },
          { $set: { status: 'expired' } }
        );
        if (lateResult.modifiedCount > 0) {
          console.log(`🌙 [expiry] 8 PM IST sweep — expired ${lateResult.modifiedCount} today system session(s)`);
        }
      }

    } catch (err) {
      console.error('[expiry] job error:', err.message);
    }
  }, 60_000);

  console.log('✅ Movie session expiry job started (60s interval)');
}

module.exports = { startMovieSessionExpiryJob };
