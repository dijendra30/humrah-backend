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
      // Find sessions whose chatExpiresAt has passed but status is still active (this could happen if chat expiry is longer than session expiry)
      // Actually, session.status is 'expired' after showTime+15m. So we should just find sessions where chatExpiresAt < now and not yet cleaned.
      // But wait, the spec says "Session becomes read-only after expiry." (which is showTime + 3 hours, i.e., chatExpiresAt).
      // Let's find sessions that just passed chatExpiresAt and clean voice notes if not cleaned yet.
      
      const chatsToExpire = await MovieSession.find({
        chatExpiresAt: { $lte: now },
        voiceNotesCleaned: { $ne: true }
      }).lean();

      if (chatsToExpire.length > 0) {
        const admin = require('firebase-admin');
        const bucket = admin.storage().bucket('humrah-d926d.firebasestorage.app');
        
        for (const session of chatsToExpire) {
          try {
            await bucket.deleteFiles({ prefix: `voice-notes/${session._id.toString()}/` });
          } catch (e) {
            console.error(`[expiry] Failed to delete voice notes for ${session._id}:`, e.message);
          }
        }
        
        await MovieSession.updateMany(
          { _id: { $in: chatsToExpire.map(s => s._id) } },
          { $set: { voiceNotesCleaned: true } }
        );
        console.log(`💬 [expiry] Cleaned voice notes for ${chatsToExpire.length} session(s)`);
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
