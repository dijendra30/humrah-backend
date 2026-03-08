/**
 * services/sessionService.js
 * ─────────────────────────────────────────────────────────────
 * All business logic for Gaming Sessions lives here.
 * Controllers call these functions; they never touch req/res.
 */

const GamingSession = require("../models/GamingSession");
const {
  isWithinThreeHours,
  calculateExpiryTime,
  isExpired,
  isWithinSpamWindow,
  nextAllowedCreateTime,
} = require("../utils/timeUtils");

// ─────────────────────────────────────────────────────────────
//  VALIDATION HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Throws if start_time is not within the allowed 3-hour window.
 */
function validateSessionTime(startTime) {
  if (!startTime) throw Object.assign(new Error("start_time is required"), { status: 400 });

  const parsed = new Date(startTime);
  if (isNaN(parsed.getTime())) throw Object.assign(new Error("start_time is not a valid date"), { status: 400 });

  if (!isWithinThreeHours(parsed)) {
    throw Object.assign(
      new Error("Session must start in the future and within the next 3 hours"),
      { status: 400 }
    );
  }
  return parsed;
}

/**
 * Throws if the user already has a non-expired, non-cancelled session.
 */
async function checkUserActiveSession(userId) {
  const existing = await GamingSession.findOne({
    creator_id: userId,
    status:     { $in: ["active", "started"] },
  });
  if (existing) {
    throw Object.assign(
      new Error("You already have an active session. Cancel it before creating a new one."),
      { status: 409, sessionId: existing._id }
    );
  }
}

/**
 * Throws if the user has created a session within the last 2 hours (anti-spam).
 * Returns { canCreate, nextAllowedAt } so callers can surface it in UI.
 */
async function checkAntiSpam(userId) {
  const recent = await GamingSession.findOne({
    creator_id: userId,
  })
    .sort({ created_at: -1 })
    .select("created_at");

  if (recent && isWithinSpamWindow(recent.created_at)) {
    const nextAt = nextAllowedCreateTime(recent.created_at);
    throw Object.assign(
      new Error(`You can create another session after ${nextAt.toISOString()}`),
      { status: 429, nextAllowedAt: nextAt.toISOString() }
    );
  }
}

// ─────────────────────────────────────────────────────────────
//  CORE SESSION OPERATIONS
// ─────────────────────────────────────────────────────────────

/**
 * Creates a new gaming session after all validations pass.
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.username
 * @param {string} params.city
 * @param {string} params.game_name
 * @param {number} params.max_players
 * @param {string|Date} params.start_time
 * @param {string?} params.optional_message
 * @returns {GamingSession}
 */
async function createSession({ userId, city, game_name, max_players, start_time, optional_message }) {
  // 1. Validate start time
  const parsedStart = validateSessionTime(start_time);

  // 2. Enforce one-active-session rule
  await checkUserActiveSession(userId);

  // 3. Anti-spam cooldown
  await checkAntiSpam(userId);

  // 4. Create the session
  const session = await GamingSession.create({
    creator_id:       userId,
    game_name:        game_name.trim(),
    max_players:      Number(max_players),
    players_joined:   1,
    players_list:     [],          // creator is NOT in players_list, tracked separately
    city:             city.trim(),
    start_time:       parsedStart,
    expires_at:       calculateExpiryTime(parsedStart),
    status:           "active",
    optional_message: optional_message?.trim() || null,
  });

  return session;
}

/**
 * Atomically adds a player to a session.
 * Uses findOneAndUpdate with a $lt guard to prevent exceeding max_players
 * even when two users join simultaneously (race condition safe).
 *
 * @param {string} sessionId
 * @param {string} userId
 * @returns {{ session, alreadyFull: boolean, alreadyJoined: boolean }}
 */
async function addPlayerToSession(sessionId, userId) {
  const objectUserId = require("mongoose").Types.ObjectId.createFromHexString
    ? require("mongoose").Types.ObjectId.createFromHexString(userId)
    : new (require("mongoose").Types.ObjectId)(userId);

  // ── Step 1: pre-checks (read-only, cheap) ─────────────────
  const existing = await GamingSession.findById(sessionId).select(
    "status max_players players_joined players_list creator_id"
  );

  if (!existing) throw Object.assign(new Error("Session not found"), { status: 404 });

  if (existing.status === "expired" || existing.status === "cancelled")
    throw Object.assign(new Error("Session is no longer available"), { status: 410 });

  if (existing.creator_id.toString() === userId)
    throw Object.assign(new Error("You created this session"), { status: 400 });

  if (existing.players_list.map(String).includes(userId))
    throw Object.assign(new Error("You have already joined this session"), { status: 400 });

  // ── Step 2: atomic join (race-condition safe) ──────────────
  // The query only succeeds if players_joined is STILL below max_players.
  // If two users try simultaneously, only one will match this query.
  const updated = await GamingSession.findOneAndUpdate(
    {
      _id:            sessionId,
      status:         { $in: ["active", "started"] },
      players_joined: { $lt: existing.max_players }, // ← the race condition guard
    },
    {
      $inc:      { players_joined: 1 },
      $addToSet: { players_list: objectUserId },
    },
    { new: true }
  );

  if (!updated) {
    // The atomic update failed — session is now full
    throw Object.assign(new Error("Session is full"), { status: 409 });
  }

  return updated;
}

/**
 * Removes a player from a session (leave).
 */
async function removePlayerFromSession(sessionId, userId) {
  const session = await GamingSession.findById(sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

  if (session.creator_id.toString() === userId) {
    throw Object.assign(
      new Error("Creators cannot leave — use cancel instead"),
      { status: 400 }
    );
  }

  if (!session.players_list.map(String).includes(userId)) {
    throw Object.assign(new Error("You are not in this session"), { status: 400 });
  }

  const updated = await GamingSession.findByIdAndUpdate(
    sessionId,
    {
      $inc:  { players_joined: -1 },
      $pull: { players_list: userId },
    },
    { new: true }
  );

  return updated;
}

/**
 * Cancels a session — only the creator can do this.
 */
async function cancelSession(sessionId, userId) {
  const session = await GamingSession.findById(sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

  if (session.creator_id.toString() !== userId) {
    throw Object.assign(new Error("Only the creator can cancel this session"), { status: 403 });
  }

  if (["expired", "cancelled"].includes(session.status)) {
    throw Object.assign(new Error("Session is already ended"), { status: 400 });
  }

  session.status = "cancelled";
  await session.save();
  return session;
}

/**
 * Returns all active (non-expired, non-cancelled) sessions for a city,
 * sorted by nearest start time.
 * Lazy-expires any stale sessions found during this query.
 *
 * @param {string} city
 * @param {string} excludeUserId  — filters out sessions this user dismissed
 */
async function getActiveSessions(city, excludeUserId) {
  const cutoff = new Date(); // now — sessions whose start is past + 5min are expired

  // Lazily expire sessions that the cron job may have missed
  await GamingSession.updateMany(
    {
      city,
      status:    { $in: ["active", "started"] },
      expires_at: { $lte: cutoff },
    },
    { $set: { status: "expired" } }
  );

  const query = {
    city,
    status:       { $in: ["active", "started"] },
    expires_at:   { $gt: cutoff },
    dismissed_by: { $ne: excludeUserId },
  };

  return GamingSession.find(query)
    .sort({ start_time: 1 })
    .populate("creator_id", "username avatar")
    .populate("players_list", "username avatar")
    .limit(30);
}

/**
 * Marks all expired sessions and returns them for socket broadcasting.
 * Called by the cron job every minute.
 * @returns {GamingSession[]} sessions that were just expired
 */
async function expireSessionsBatch() {
  const now = new Date();

  // Find them first so we can emit socket events with their IDs
  const toExpire = await GamingSession.find({
    status:     { $in: ["active", "started"] },
    expires_at: { $lte: now },
  }).select("_id city");

  if (toExpire.length === 0) return [];

  const ids = toExpire.map((s) => s._id);
  await GamingSession.updateMany(
    { _id: { $in: ids } },
    { $set: { status: "expired" } }
  );

  return toExpire;
}

module.exports = {
  validateSessionTime,
  checkUserActiveSession,
  checkAntiSpam,
  createSession,
  addPlayerToSession,
  removePlayerFromSession,
  cancelSession,
  getActiveSessions,
  expireSessionsBatch,
};
