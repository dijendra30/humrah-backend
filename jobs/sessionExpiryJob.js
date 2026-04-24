/**
 * jobs/sessionExpiryJob.js
 *
 * Runs every 60 seconds.
 *
 * ── DUAL-STATUS SYSTEM ────────────────────────────────────────
 * Step 1: cardExpiresAt (= startTime) passed → cardStatus = 'expired'
 *         chatStatus is NEVER touched by card expiry
 * Step 2: chatExpiresAt (= startTime + 3h) passed → chatStatus = 'closed'
 *         cardStatus is NEVER touched by chat expiry
 *
 * Documents are NEVER deleted — history kept permanently in DB.
 *
 * FIX: Old version used snake_case field names (`hostId`, `hostUsername`,
 * `expiresAt`) which don't exist in the GamingSession model.
 * Corrected to camelCase (`creatorId`, `creatorUsername`, `cardExpiresAt`,
 * `chatExpiresAt`, `cardStatus`, `chatStatus`).
 */

const GamingSession = require('../models/GamingSession');
const {
  emitSessionExpired,
} = require('../sockets/sessionSocket');

function startExpiryJob(io) {
  setInterval(async () => {
    try {
      const now = new Date();

      // ── Step 1: Expire the CARD at startTime ─────────────────────────────
      // cardExpiresAt = startTime (set on create)
      // ✅ FIX: Use `cardStatus` and `cardExpiresAt` (was `status` / `expiresAt`)
      const cardResult = await GamingSession.updateMany(
        {
          cardStatus:    { $in: ["waiting", "full"] },
          cardExpiresAt: { $lte: now },
        },
        {
          $set: {
            cardStatus: "expired",
            // ✅ Also sync legacy status field for old clients
            status: "expired",
          }
          // ⚠️ chatStatus intentionally NOT touched here
        }
      );

      if (cardResult.modifiedCount > 0) {
        console.log(`[ExpiryJob] Step 1: ${cardResult.modifiedCount} card(s) expired at startTime`);

        if (io) {
          const justExpired = await GamingSession.find({
            cardStatus: "expired",
            updatedAt:  { $gte: new Date(now.getTime() - 70_000) },
          }).select("_id city");

          for (const s of justExpired) {
            emitSessionExpired(io, s._id.toString(), s.city);
          }
        }
      }

      // ── Step 2: Close the CHAT at startTime + 3h ─────────────────────────
      // chatExpiresAt = startTime + 3h (set on create)
      // ✅ FIX: Use `chatStatus` and `chatExpiresAt` (were missing entirely)
      const chatResult = await GamingSession.updateMany(
        {
          chatStatus:    "open",
          chatExpiresAt: { $lte: now },
        },
        {
          $set: { chatStatus: "closed" }
          // ⚠️ cardStatus intentionally NOT touched here
          // ⚠️ No deleteOne — documents kept in DB permanently
        }
      );

      if (chatResult.modifiedCount > 0) {
        console.log(`[ExpiryJob] Step 2: ${chatResult.modifiedCount} chat(s) closed at startTime+3h — documents kept`);
      }

    } catch (err) {
      console.error('[ExpiryJob] Error:', err.message);
    }
  }, 60_000);

  console.log('[ExpiryJob] Dual-status session expiry job started (60s interval)');
}

module.exports = { startExpiryJob };
