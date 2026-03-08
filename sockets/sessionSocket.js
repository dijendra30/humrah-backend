/**
 * sockets/sessionSocket.js
 * ─────────────────────────────────────────────────────────────
 * Socket.io namespace for real-time gaming session events.
 *
 * Room strategy:
 *   • "city:<cityName>"       — joined on connect; receives session_created,
 *                               session_updated, session_expired for that city
 *   • "session:<sessionId>"   — joined when a user joins/opens a session;
 *                               receives player_joined, player_left, session_started
 *
 * Authentication:
 *   JWT token must be passed in socket handshake auth:
 *     socket = io(URL, { auth: { token: "Bearer <jwt>" } })
 */

const { verifySocketToken } = require("../middleware/authMiddleware");
const sessionService         = require("../services/sessionService");
const { getRemainingTime }   = require("../utils/timeUtils");

/**
 * Initialises the /gaming Socket.io namespace.
 * @param {import("socket.io").Server} io
 */
function initSessionSocket(io) {
  // Use a dedicated namespace to keep gaming events isolated
  const gamingNS = io.of("/gaming");

  // ── Auth middleware for this namespace ──────────────────────
  gamingNS.use((socket, next) => {
    try {
      const raw   = socket.handshake.auth?.token || "";
      const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
      const user  = verifySocketToken(token);

      socket.data.user = user;   // { _id, username, city }
      next();
    } catch (err) {
      next(new Error("Authentication failed: " + err.message));
    }
  });

  // ── Connection handler ──────────────────────────────────────
  gamingNS.on("connection", (socket) => {
    const { _id: userId, username, city } = socket.data.user;
    console.log(`[Socket] ${username} (${userId}) connected — city: ${city}`);

    // Auto-join the city room so they receive relevant broadcasts
    socket.join(`city:${city}`);

    // ── CLIENT EVENTS ───────────────────────────────────────
    //
    // join_session_room
    // Client emits this when they open a session detail / join a session.
    // Puts the socket in the session room so it receives granular updates.
    //
    socket.on("join_session_room", ({ session_id }) => {
      if (!session_id) return;
      socket.join(`session:${session_id}`);
      console.log(`[Socket] ${username} joined room session:${session_id}`);
    });

    // leave_session_room
    // Client emits this when they close the session detail screen.
    socket.on("leave_session_room", ({ session_id }) => {
      if (!session_id) return;
      socket.leave(`session:${session_id}`);
    });

    // ping_session  (client can request a fresh snapshot)
    socket.on("ping_session", async ({ session_id }, callback) => {
      try {
        const GamingSession = require("../models/GamingSession");
        const session = await GamingSession.findById(session_id)
          .populate("creator_id",  "username")
          .populate("players_list", "username");

        if (!session) return callback?.({ error: "Session not found" });

        callback?.({
          session_id:     session._id,
          players_joined: session.players_joined,
          max_players:    session.max_players,
          spots_left:     session.spots_left,
          status:         session.status,
          seconds_left:   getRemainingTime(session.start_time),
        });
      } catch (err) {
        callback?.({ error: err.message });
      }
    });

    // disconnect
    socket.on("disconnect", (reason) => {
      console.log(`[Socket] ${username} disconnected — ${reason}`);
    });
  });

  return gamingNS;
}

// ─────────────────────────────────────────────────────────────
//  SERVER-SIDE EMIT HELPERS
//  Call these from anywhere that has access to `io`.
// ─────────────────────────────────────────────────────────────

/**
 * Broadcast to everyone in the city feed that a new session appeared.
 */
function emitSessionCreated(io, city, session) {
  io.of("/gaming").to(`city:${city}`).emit("session_created", session);
}

/**
 * Broadcast player count update to city feed + session room.
 */
function emitPlayerJoined(io, session) {
  const payload = {
    session_id:     session._id,
    players_joined: session.players_joined,
    max_players:    session.max_players,
    spots_left:     session.spots_left,
  };
  io.of("/gaming").to(`session:${session._id}`).emit("player_joined", payload);
  io.of("/gaming").to(`city:${session.city}`).emit("session_updated", payload);
}

/**
 * Broadcast player count update when someone leaves.
 */
function emitPlayerLeft(io, session) {
  const payload = {
    session_id:     session._id,
    players_joined: session.players_joined,
    spots_left:     session.spots_left,
  };
  io.of("/gaming").to(`session:${session._id}`).emit("player_left", payload);
  io.of("/gaming").to(`city:${session.city}`).emit("session_updated", payload);
}

/**
 * Broadcast that a session has started (start_time reached).
 */
function emitSessionStarted(io, sessionId, city) {
  const payload = { session_id: sessionId };
  io.of("/gaming").to(`session:${sessionId}`).emit("session_started", payload);
  io.of("/gaming").to(`city:${city}`).emit("session_started", payload);
}

/**
 * Broadcast that a session has expired or been cancelled.
 */
function emitSessionExpired(io, sessionId, city) {
  const payload = { session_id: sessionId };
  io.of("/gaming").to(`session:${sessionId}`).emit("session_expired", payload);
  io.of("/gaming").to(`city:${city}`).emit("session_expired", payload);
}

module.exports = {
  initSessionSocket,
  emitSessionCreated,
  emitPlayerJoined,
  emitPlayerLeft,
  emitSessionStarted,
  emitSessionExpired,
};
