/**
 * controllers/gamingController.js
 * ─────────────────────────────────────────────────────────────
 * Thin request/response layer.
 * Each function:
 *   1. Extracts data from req
 *   2. Calls the service
 *   3. Emits a socket event
 *   4. Returns the HTTP response
 *
 * NO business logic here.
 */

const sessionService = require("../services/sessionService");
const { getRemainingTime } = require("../utils/timeUtils");

// ─────────────────────────────────────────────────────────────
//  POST /session/create
// ─────────────────────────────────────────────────────────────
async function createSession(req, res) {
  try {
    const { game_name, max_players, start_time, optional_message } = req.body;
    const userId = req.user._id;
    const city   = req.user.city;   // city comes from the JWT payload

    // Basic input validation
    if (!game_name)   return res.status(400).json({ error: "game_name is required" });
    if (!max_players) return res.status(400).json({ error: "max_players is required" });
    if (!start_time)  return res.status(400).json({ error: "start_time is required" });

    const session = await sessionService.createSession({
      userId,
      city,
      game_name,
      max_players,
      start_time,
      optional_message,
    });

    // Broadcast to everyone in the same city room
    const io = req.app.get("io");
    io.to(`city:${city}`).emit("session_created", formatSession(session));

    return res.status(201).json({
      message: "Session created",
      session: formatSession(session),
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
//  GET /session/active
// ─────────────────────────────────────────────────────────────
async function getActiveSessions(req, res) {
  try {
    const city   = req.user.city;
    const userId = req.user._id.toString();

    const sessions = await sessionService.getActiveSessions(city, userId);

    return res.json({
      count:    sessions.length,
      sessions: sessions.map(formatSession),
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
//  POST /session/join
// ─────────────────────────────────────────────────────────────
async function joinSession(req, res) {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id is required" });

    const userId  = req.user._id.toString();
    const session = await sessionService.addPlayerToSession(session_id, userId);

    const io = req.app.get("io");
    io.to(`session:${session_id}`).emit("player_joined", {
      session_id,
      players_joined: session.players_joined,
      max_players:    session.max_players,
      spots_left:     session.spots_left,
    });
    // Also notify city room so feed updates
    io.to(`city:${session.city}`).emit("session_updated", {
      session_id,
      players_joined: session.players_joined,
    });

    return res.json({
      message: "Joined session",
      session: formatSession(session),
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
//  POST /session/leave
// ─────────────────────────────────────────────────────────────
async function leaveSession(req, res) {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id is required" });

    const userId  = req.user._id.toString();
    const session = await sessionService.removePlayerFromSession(session_id, userId);

    const io = req.app.get("io");
    io.to(`session:${session_id}`).emit("player_left", {
      session_id,
      players_joined: session.players_joined,
      spots_left:     session.spots_left,
    });
    io.to(`city:${session.city}`).emit("session_updated", {
      session_id,
      players_joined: session.players_joined,
    });

    return res.json({ message: "Left session", session: formatSession(session) });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
//  POST /session/cancel
// ─────────────────────────────────────────────────────────────
async function cancelSession(req, res) {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id is required" });

    const userId  = req.user._id.toString();
    const session = await sessionService.cancelSession(session_id, userId);

    const io = req.app.get("io");
    io.to(`city:${session.city}`).emit("session_expired", { session_id });
    io.to(`session:${session_id}`).emit("session_expired", { session_id });

    return res.json({ message: "Session cancelled" });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/** Serialize a session for API responses */
function formatSession(s) {
  return {
    session_id:       s._id,
    creator_id:       s.creator_id,
    game_name:        s.game_name,
    max_players:      s.max_players,
    players_joined:   s.players_joined,
    players_list:     s.players_list,
    spots_left:       s.spots_left,
    is_full:          s.is_full,
    city:             s.city,
    start_time:       s.start_time,
    expires_at:       s.expires_at,
    status:           s.status,
    optional_message: s.optional_message,
    seconds_left:     getRemainingTime(s.start_time),
    created_at:       s.created_at,
  };
}

/** Unified error handler — maps service errors to HTTP status codes */
function handleError(res, err) {
  console.error(`[GamingController] ${err.message}`);
  const status = err.status || 500;
  const body   = { error: err.message };
  if (err.nextAllowedAt) body.next_allowed_at = err.nextAllowedAt;
  if (err.sessionId)     body.session_id      = err.sessionId;
  return res.status(status).json(body);
}

module.exports = {
  createSession,
  getActiveSessions,
  joinSession,
  leaveSession,
  cancelSession,
};
