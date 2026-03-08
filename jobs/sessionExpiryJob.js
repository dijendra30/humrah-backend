/**
 * jobs/sessionExpiryJob.js
 * ─────────────────────────────────────────────────────────────
 * Cron job — runs every 60 seconds.
 *
 * Tasks:
 *  1. Finds all sessions whose start_time + 5 min has passed.
 *  2. Marks them "expired" in MongoDB.
 *  3. Emits "session_expired" via Socket.io to the city room
 *     and the session room so clients remove them from the UI.
 *  4. Also marks "active" sessions whose start_time has passed
 *     (but not yet expired) as "started" — so the join button
 *     can show "In Progress" state.
 */

const GamingSession = require("../models/GamingSession");
const {
  emitSessionExpired,
  emitSessionStarted,
} = require("../sockets/sessionSocket");

let jobTimer = null;

/**
 * Starts the expiry cron job.
 * @param {import("socket.io").Server} io  — needed for socket emissions
 */
function startExpiryJob(io) {
  if (jobTimer) {
    console.warn("[ExpiryJob] Already running — skipping duplicate start");
    return;
  }

  console.log("[ExpiryJob] Started — checking every 60 seconds");

  // Run immediately on start, then every 60 seconds
  runExpiryTick(io);
  jobTimer = setInterval(() => runExpiryTick(io), 60_000);
}

/**
 * Stops the job (useful for graceful shutdown / testing).
 */
function stopExpiryJob() {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
    console.log("[ExpiryJob] Stopped");
  }
}

// ─────────────────────────────────────────────────────────────
//  CORE TICK LOGIC
// ─────────────────────────────────────────────────────────────

async function runExpiryTick(io) {
  try {
    const now = new Date();

    // ── 1. Expire sessions past the 5-min grace window ────────
    const toExpire = await GamingSession.find({
      status:     { $in: ["active", "started"] },
      expires_at: { $lte: now },
    }).select("_id city");

    if (toExpire.length > 0) {
      const ids = toExpire.map((s) => s._id);

      await GamingSession.updateMany(
        { _id: { $in: ids } },
        { $set: { status: "expired" } }
      );

      // Emit socket events per session
      for (const session of toExpire) {
        emitSessionExpired(io, session._id.toString(), session.city);
      }

      console.log(`[ExpiryJob] Expired ${toExpire.length} session(s)`);
    }

    // ── 2. Mark sessions whose start_time has passed as "started" ─
    //    These are still within the 5-min grace window.
    const toStart = await GamingSession.find({
      status:     "active",
      start_time: { $lte: now },
      expires_at: { $gt: now },
    }).select("_id city");

    if (toStart.length > 0) {
      const ids = toStart.map((s) => s._id);

      await GamingSession.updateMany(
        { _id: { $in: ids } },
        { $set: { status: "started" } }
      );

      for (const session of toStart) {
        emitSessionStarted(io, session._id.toString(), session.city);
      }

      console.log(`[ExpiryJob] Marked ${toStart.length} session(s) as started`);
    }
  } catch (err) {
    // Log but never crash the process
    console.error("[ExpiryJob] Tick error:", err.message);
  }
}

module.exports = { startExpiryJob, stopExpiryJob };
