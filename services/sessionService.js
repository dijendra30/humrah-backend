/**
 * services/sessionService.js
 * ─────────────────────────────────────────────────────────────
 * All business logic for Gaming Sessions lives here.
 * Controllers call these functions; they never touch req/res.
 *
 * FIX: All snake_case field references (creator_id, game_name,
 * max_players, players_joined, players_list, start_time,
 * expires_at, created_at, dismissed_by) updated to camelCase
 * to match the GamingSession model (creatorId, gameType,
 * playersNeeded, playersJoined, startTime, cardExpiresAt,
 * createdAt, dismissedBy).
 */

const GamingSession = require("../models/GamingSession");
const {
  isWithinThreeHours,
  isWithinSpamWindow,
  nextAllowedCreateTime,
} = require("../utils/timeUtils");

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const TWO_HOURS_MS   = 2 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
//  VALIDATION HELPERS
// ─────────────────────────────────────────────────────────────

function validateSessionTime(startTime) {
  if (!startTime) throw Object.assign(new Error("startTime is required"), { status: 400 });
  const parsed = new Date(startTime);
  if (isNaN(parsed.getTime())) throw Object.assign(new Error("startTime is not a valid date"), { status: 400 });
  if (!isWithinThreeHours(parsed)) {
    throw Object.assign(
      new Error("Session must start in the future and within the next 3 hours"),
      { status: 400 }
    );
  }
  return parsed;
}

async function checkUserActiveSession(userId) {
  // ✅ FIX: Use camelCase field `creatorId` (was `creator_id`)
  // ✅ FIX: Use `cardStatus` field (was legacy `status`)
  const existing = await GamingSession.findOne({
    creatorId:  userId,
    cardStatus: { $in: ["waiting", "full", "started"] },
  });
  if (existing) {
    throw Object.assign(
      new Error("You already have an active session. Cancel it before creating a new one."),
      { status: 409, sessionId: existing._id }
    );
  }
}

async function checkAntiSpam(userId) {
  // ✅ FIX: Use camelCase field `creatorId` (was `creator_id`)
  // ✅ FIX: Use camelCase field `createdAt` (was `created_at`)
  const recent = await GamingSession.findOne({ creatorId: userId })
    .sort({ createdAt: -1 })
    .select("createdAt");

  if (recent && isWithinSpamWindow(recent.createdAt)) {
    const nextAt = nextAllowedCreateTime(recent.createdAt);
    throw Object.assign(
      new Error(`You can create another session after ${nextAt.toISOString()}`),
      { status: 429, nextAllowedAt: nextAt.toISOString() }
    );
  }
}

// ─────────────────────────────────────────────────────────────
//  CORE SESSION OPERATIONS
// ─────────────────────────────────────────────────────────────

async function createSession({ userId, username, city, gameType, playersNeeded, startTime, optionalMessage }) {
  const parsedStart = validateSessionTime(startTime);
  await checkUserActiveSession(userId);
  await checkAntiSpam(userId);

  // ✅ FIX: All camelCase field names matching GamingSession model
  const cardExpiresAt = new Date(parsedStart.getTime());
  const chatExpiresAt = new Date(parsedStart.getTime() + THREE_HOURS_MS);

  const session = await GamingSession.create({
    creatorId:       userId,
    creatorUsername: username || "User",
    city:            city.trim(),
    gameType:        (gameType || "OTHER").trim(),
    playersNeeded:   Number(playersNeeded),
    playersJoined:   [],
    startTime:       parsedStart,
    cardExpiresAt,
    chatExpiresAt,
    cardStatus:      "waiting",
    chatStatus:      "open",
    status:          "waiting_for_players",
    optionalMessage: optionalMessage?.trim() || null,
  });

  return session;
}

async function addPlayerToSession(sessionId, userId) {
  const mongoose = require("mongoose");
  const objectUserId = new mongoose.Types.ObjectId(userId);

  // ✅ FIX: All camelCase field names (was players_joined, max_players, creator_id, players_list)
  const existing = await GamingSession.findById(sessionId).select(
    "cardStatus playersNeeded playersJoined creatorId kickedPlayers"
  );

  if (!existing) throw Object.assign(new Error("Session not found"), { status: 404 });

  if (!["waiting", "full", "started"].includes(existing.cardStatus))
    throw Object.assign(new Error("Session is no longer available"), { status: 410 });

  if (existing.creatorId.toString() === userId)
    throw Object.assign(new Error("You created this session"), { status: 400 });

  if ((existing.kickedPlayers || []).map(String).includes(userId))
    throw Object.assign(new Error("You were removed from this session"), { status: 403 });

  if (existing.playersJoined.map(String).includes(userId))
    throw Object.assign(new Error("You have already joined this session"), { status: 400 });

  // ✅ FIX: Atomic update using camelCase fields
  const updated = await GamingSession.findOneAndUpdate(
    {
      _id:          sessionId,
      cardStatus:   { $in: ["waiting", "full", "started"] },
      $expr:        { $lt: [{ $size: "$playersJoined" }, "$playersNeeded"] },
    },
    { $addToSet: { playersJoined: objectUserId } },
    { new: true }
  );

  if (!updated) throw Object.assign(new Error("Session is full"), { status: 409 });

  // Update cardStatus to full if needed
  if (updated.playersJoined.length >= updated.playersNeeded && updated.cardStatus === "waiting") {
    updated.cardStatus = "full";
    updated.status     = "full";
    await updated.save();
  }

  return updated;
}

async function removePlayerFromSession(sessionId, userId) {
  // ✅ FIX: All camelCase field names
  const session = await GamingSession.findById(sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

  if (session.creatorId.toString() === userId) {
    throw Object.assign(new Error("Creators cannot leave — use cancel instead"), { status: 400 });
  }

  if (!session.playersJoined.map(String).includes(userId)) {
    throw Object.assign(new Error("You are not in this session"), { status: 400 });
  }

  const updated = await GamingSession.findByIdAndUpdate(
    sessionId,
    { $pull: { playersJoined: userId } },
    { new: true }
  );

  // Revert cardStatus if was full
  if (updated.cardStatus === "full") {
    updated.cardStatus = "waiting";
    updated.status     = "waiting_for_players";
    await updated.save();
  }

  return updated;
}

async function cancelSession(sessionId, userId) {
  // ✅ FIX: All camelCase field names
  const session = await GamingSession.findById(sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

  if (session.creatorId.toString() !== userId) {
    throw Object.assign(new Error("Only the creator can cancel this session"), { status: 403 });
  }

  if (["expired", "cancelled"].includes(session.cardStatus)) {
    throw Object.assign(new Error("Session is already ended"), { status: 400 });
  }

  session.cardStatus = "cancelled";
  session.chatStatus = "closed";
  session.status     = "cancelled";
  await session.save();
  return session;
}

async function getActiveSessions(city, excludeUserId) {
  const now = new Date();

  // ✅ FIX: Use camelCase fields (was expires_at, dismissed_by)
  await GamingSession.updateMany(
    {
      city,
      cardStatus:    { $in: ["waiting", "full"] },
      cardExpiresAt: { $lte: now },
    },
    { $set: { cardStatus: "expired" } }
  );

  return GamingSession.find({
    city,
    cardStatus:         { $in: ["waiting", "full", "started"] },
    cardExpiresAt:      { $gt: now },
    notInterestedUsers: { $ne: excludeUserId },
    dismissedBy:        { $ne: excludeUserId },
  })
    .sort({ startTime: 1 })
    .populate("creatorId", "firstName lastName profilePhoto")
    .populate("playersJoined", "firstName lastName profilePhoto")
    .limit(30);
}

async function expireSessionsBatch() {
  const now = new Date();

  // ✅ FIX: Use camelCase fields
  const toExpire = await GamingSession.find({
    cardStatus:    { $in: ["waiting", "full"] },
    cardExpiresAt: { $lte: now },
  }).select("_id city");

  if (toExpire.length === 0) return [];

  const ids = toExpire.map((s) => s._id);
  await GamingSession.updateMany(
    { _id: { $in: ids } },
    { $set: { cardStatus: "expired" } }
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
