/**
 * jobs/sessionExpiryJob.js
 *
 * Cron job that runs every minute and:
 *  1. Marks sessions EXPIRED when chatExpiresAt has passed
 *  2. Emits session_expired socket events to all participants + city room
 *
 * Usage in server.js:
 *   const { startExpiryJob } = require('./jobs/sessionExpiryJob');
 *   startExpiryJob(io);
 */

const cron         = require("node-cron");
const GamingSession = require("../models/GamingSession");
const { emitSessionExpired } = require("../sockets/sessionSocket");

let _io = null;

/**
 * Run a single expiry sweep — exported so tests can call it directly.
 */
async function runExpirySweep() {
  try {
    const now = new Date();

    // Find all sessions that should be expired but aren't yet
    const expired = await GamingSession.find({
      status:       { $in: ["ACTIVE", "STARTED"] },
      chatExpiresAt: { $lte: now },
    }).select("_id city status");

    if (expired.length === 0) return;

    const ids = expired.map((s) => s._id);

    // Bulk update
    await GamingSession.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "EXPIRED" } }
    );

    // Emit socket events for each expired session
    if (_io) {
      for (const session of expired) {
        emitSessionExpired(_io, session._id.toString(), session.city);
      }
    }

    console.log(`[ExpiryJob] Expired ${expired.length} session(s) at ${now.toISOString()}`);
  } catch (err) {
    console.error("[ExpiryJob] Error during sweep:", err.message);
  }
}

/**
 * Start the cron job.
 * @param {import('socket.io').Server} io
 */
function startExpiryJob(io) {
  _io = io;

  // Run every minute: "* * * * *"
  cron.schedule("* * * * *", runExpirySweep);

  // Also run immediately on startup to catch anything that expired while server was down
  runExpirySweep();

  console.log("[ExpiryJob] Session expiry job started — running every minute.");
}

module.exports = { startExpiryJob, runExpirySweep };
