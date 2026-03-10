/**
 * sockets/sessionSocket.js
 * Socket.io /gaming namespace — updated with host power events.
 * Import and call initSessionSocket(io) from your server.js.
 */
const jwt = require("jsonwebtoken");

function verifySocketToken(token) {
  if (!token) throw new Error("No token");
  const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret_change_in_production");
  return {
    _id:      decoded.userId || decoded._id,
    username: decoded.username,
    city:     decoded.city,
  };
}

function initSessionSocket(io) {
  const ns = io.of("/gaming");

  ns.use((socket, next) => {
    try {
      const raw   = socket.handshake.auth?.token || "";
      const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
      socket.data.user = verifySocketToken(token);
      next();
    } catch (e) { next(new Error("Auth failed: " + e.message)); }
  });

  ns.on("connection", (socket) => {
    const { city } = socket.data.user;
    socket.join(`city:${city}`);

    socket.on("join_session_room",  ({ session_id }) => { if (session_id) socket.join(`session:${session_id}`); });
    socket.on("leave_session_room", ({ session_id }) => { if (session_id) socket.leave(`session:${session_id}`); });

    socket.on("ping_session", async ({ session_id }, cb) => {
      try {
        const GamingSession = require("../models/GamingSession");
        const s = await GamingSession.findById(session_id);
        if (!s) return cb?.({ error: "Not found" });
        cb?.({
          session_id:    s._id, playersJoined: s.playersJoined.map(String),
          playersNeeded: s.playersNeeded, status: s.status,
          chatExpiresAt: s.chatExpiresAt.toISOString(),
        });
      } catch (e) { cb?.({ error: e.message }); }
    });
  });

  return ns;
}

// ── Emit helpers ───────────────────────────────────────────────
function emitSessionCreated(io, city, session) {
  io.of("/gaming").to(`city:${city}`).emit("session_created", session);
}
function emitPlayerJoined(io, session) {
  const p = { session_id: session._id.toString(), playersJoined: session.playersJoined.map(String), playersNeeded: session.playersNeeded };
  io.of("/gaming").to(`session:${session._id}`).emit("player_joined", p);
  io.of("/gaming").to(`city:${session.city}`).emit("session_updated", p);
}
function emitPlayerLeft(io, session, userId) {
  const p = { session_id: session._id.toString(), userId, playersJoined: session.playersJoined.map(String) };
  io.of("/gaming").to(`session:${session._id}`).emit("player_left", p);
}
function emitSessionStarted(io, sessionId, city) {
  const p = { session_id: sessionId };
  io.of("/gaming").to(`session:${sessionId}`).emit("session_started", p);
  io.of("/gaming").to(`city:${city}`).emit("session_started", p);
}
function emitSessionExpired(io, sessionId, city) {
  const p = { session_id: sessionId };
  io.of("/gaming").to(`session:${sessionId}`).emit("session_expired", p);
  io.of("/gaming").to(`city:${city}`).emit("session_expired", p);
}
function emitSessionCancelled(io, sessionId, city) {
  const p = { session_id: sessionId };
  io.of("/gaming").to(`session:${sessionId}`).emit("session_cancelled", p);
  io.of("/gaming").to(`city:${city}`).emit("session_cancelled", p);
}
function emitPlayerKicked(io, sessionId, city, targetUserId) {
  io.of("/gaming").to(`session:${sessionId}`).emit("player_removed", { session_id: sessionId, userId: targetUserId });
  io.of("/gaming").to(`city:${city}`).emit("session_updated", { session_id: sessionId });
}
function emitPlayerMuted(io, sessionId, targetUserId, mutedUntil) {
  io.of("/gaming").to(`session:${sessionId}`).emit("player_muted", { session_id: sessionId, userId: targetUserId, mutedUntil });
}
function emitPinnedMessage(io, sessionId, message) {
  io.of("/gaming").to(`session:${sessionId}`).emit("message_pinned", { session_id: sessionId, message });
}
function emitNewReaction(io, sessionId, data) {
  io.of("/gaming").to(`session:${sessionId}`).emit("reaction_updated", { session_id: sessionId, ...data });
}

/**
 * Broadcast a new chat message to every participant in the session room.
 * Payload shape matches the ChatMessageDto the Android client already parses.
 */
function emitNewMessage(io, sessionId, message) {
  io.of("/gaming").to(`session:${sessionId}`).emit("new_message", { session_id: sessionId, message });
}

module.exports = {
  initSessionSocket,
  emitSessionCreated, emitPlayerJoined, emitPlayerLeft,
  emitSessionStarted, emitSessionExpired, emitSessionCancelled,
  emitPlayerKicked, emitPlayerMuted, emitPinnedMessage, emitNewReaction,
  emitNewMessage,
};
