const jwt        = require('jsonwebtoken');
const GamingSession = require('../models/GamingSession');

/**
 * sessionSocket.js
 *
 * Socket.io namespace: /gaming
 *
 * Rooms:
 *   city:{city}         → all users in a city see new sessions
 *   session:{sessionId} → participants get chat + player events
 *
 * Auth: JWT in socket.handshake.auth.token
 */

function initSessionSocket(io) {
  const gaming = io.of('/gaming');

  // ── JWT auth middleware ────────────────────────────────────
  gaming.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = {
        userId:   decoded.userId || decoded.id,
        username: decoded.username,
        city:     decoded.city
      };
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  gaming.on('connection', (socket) => {
    const { userId, username, city } = socket.user;
    console.log(`[GamingSocket] Connected: ${username} (${userId}) city=${city}`);

    // ── Auto-join city room on connect ────────────────────────
    if (city) {
      socket.join(`city:${city}`);
      console.log(`[GamingSocket] ${username} joined city:${city}`);
    }

    // ── Client joins a specific session room ──────────────────
    socket.on('join_session_room', ({ session_id }) => {
      if (!session_id) return;
      socket.join(`session:${session_id}`);
      console.log(`[GamingSocket] ${username} joined session:${session_id}`);
    });

    // ── Client leaves a session room ──────────────────────────
    socket.on('leave_session_room', ({ session_id }) => {
      if (!session_id) return;
      socket.leave(`session:${session_id}`);
      console.log(`[GamingSocket] ${username} left session:${session_id}`);
    });

    // ── Ping / heartbeat ──────────────────────────────────────
    socket.on('ping_session', ({ session_id }) => {
      socket.emit('pong_session', { session_id, ts: Date.now() });
    });

    // ── Disconnect ────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[GamingSocket] Disconnected: ${username} — ${reason}`);
    });
  });

  console.log('[GamingSocket] /gaming namespace initialized');
}

// ─────────────────────────────────────────────────────────────
//  EMIT HELPERS  (used by routes to fire events)
// ─────────────────────────────────────────────────────────────

function emitSessionCreated(io, city, session) {
  io.of('/gaming').to(`city:${city}`).emit('session_created', session);
}

function emitPlayerJoined(io, sessionId, city, payload) {
  io.of('/gaming').to(`city:${city}`).emit('session_updated', payload);
  io.of('/gaming').to(`session:${sessionId}`).emit('player_joined', payload);
}

function emitPlayerLeft(io, sessionId, city, payload) {
  io.of('/gaming').to(`city:${city}`).emit('session_updated', payload);
  io.of('/gaming').to(`session:${sessionId}`).emit('player_left', payload);
}

function emitPlayerRemoved(io, sessionId, payload) {
  io.of('/gaming').to(`session:${sessionId}`).emit('player_removed', payload);
}

function emitPlayerMuted(io, sessionId, payload) {
  io.of('/gaming').to(`session:${sessionId}`).emit('player_muted', payload);
}

function emitNewMessage(io, sessionId, message) {
  io.of('/gaming').to(`session:${sessionId}`).emit('new_message', {
    session_id: sessionId,
    message
  });
}

function emitSessionStarted(io, sessionId, city) {
  const payload = { session_id: sessionId };
  io.of('/gaming').to(`city:${city}`).emit('session_started', payload);
  io.of('/gaming').to(`session:${sessionId}`).emit('session_started', payload);
}

function emitSessionExpired(io, sessionId, city) {
  const payload = { session_id: sessionId };
  io.of('/gaming').to(`city:${city}`).emit('session_expired', payload);
  io.of('/gaming').to(`session:${sessionId}`).emit('session_expired', payload);
}

function emitSessionCancelled(io, sessionId, city) {
  const payload = { session_id: sessionId };
  io.of('/gaming').to(`city:${city}`).emit('session_cancelled', payload);
  io.of('/gaming').to(`session:${sessionId}`).emit('session_cancelled', payload);
}

function emitPinnedMessage(io, sessionId, message) {
  io.of('/gaming').to(`session:${sessionId}`).emit('message_pinned', {
    session_id: sessionId,
    message
  });
}

function emitNewReaction(io, sessionId, messageId, reactions) {
  io.of('/gaming').to(`session:${sessionId}`).emit('reaction_updated', {
    session_id: sessionId,
    messageId,
    reactions
  });
}

module.exports = {
  initSessionSocket,
  emitSessionCreated,
  emitPlayerJoined,
  emitPlayerLeft,
  emitPlayerRemoved,
  emitPlayerMuted,
  emitNewMessage,
  emitSessionStarted,
  emitSessionExpired,
  emitSessionCancelled,
  emitPinnedMessage,
  emitNewReaction
};
