const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

/**
 * sessionSocket.js — /gaming namespace
 *
 * JWT does NOT include city or username in this app.
 * We fetch them from DB after auth, same as the main socket in server.js.
 *
 * Rooms:
 *   city:{city}         — feed updates for everyone in a city
 *   session:{sessionId} — chat + player events for participants
 */

function initSessionSocket(io) {
  const gaming = io.of('/gaming');

  // ── JWT auth middleware ────────────────────────────────────
  gaming.use(async (socket, next) => {
    try {
      // Accept token from same places as main socket
      let token = socket.handshake.auth?.token ||
                  socket.handshake.query?.token ||
                  socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) return next(new Error('Authentication error: No token provided'));

      const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_production';
      const decoded    = jwt.verify(token, JWT_SECRET);

      socket.userId = decoded.userId || decoded.id || decoded._id;

      // Fetch full user from DB — same pattern as server.js main socket
      const User = mongoose.model('User');
      const user = await User.findById(socket.userId)
        .select('firstName lastName profilePhoto questionnaire city')
        .lean();

      if (user) {
        socket.userName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User';
        socket.userCity =
          user.questionnaire?.city ||
          user.city ||
          decoded.city ||
          'Unknown';
      } else {
        socket.userName = 'User';
        socket.userCity = decoded.city || 'Unknown';
      }

      next();
    } catch (err) {
      console.log('[GamingSocket] Auth failed:', err.message);
      next(new Error('Authentication error: ' + err.message));
    }
  });

  gaming.on('connection', (socket) => {
    const { userId, userName, userCity } = socket;
    console.log(`[GamingSocket] Connected: ${userName} (${userId}) city=${userCity}`);

    // Auto-join city room so user sees new sessions in their city
    if (userCity && userCity !== 'Unknown') {
      socket.join(`city:${userCity}`);
    }

    // ── Join a specific session room ──────────────────────────
    socket.on('join_session_room', ({ session_id }) => {
      if (!session_id) return;
      socket.join(`session:${session_id}`);
      console.log(`[GamingSocket] ${userName} joined session:${session_id}`);
    });

    // ── Leave a specific session room ─────────────────────────
    socket.on('leave_session_room', ({ session_id }) => {
      if (!session_id) return;
      socket.leave(`session:${session_id}`);
      console.log(`[GamingSocket] ${userName} left session:${session_id}`);
    });

    // ── Heartbeat ─────────────────────────────────────────────
    socket.on('ping_session', ({ session_id }) => {
      socket.emit('pong_session', { session_id, ts: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      console.log(`[GamingSocket] Disconnected: ${userName} — ${reason}`);
    });
  });

  console.log('[GamingSocket] /gaming namespace initialized');
}

// ─────────────────────────────────────────────────────────────
//  EMIT HELPERS  (called from gamingRoutes.js)
// ─────────────────────────────────────────────────────────────

function emitSessionCreated(io, city, session) {
  io.of('/gaming').to(`city:${city}`).emit('session_created', session);
}

function emitPlayerJoined(io, session) {
  const payload = {
    session_id:    session._id.toString(),
    playersJoined: (session.playersJoined || []).map(String)
  };
  io.of('/gaming').to(`city:${session.city}`).emit('session_updated', payload);
  io.of('/gaming').to(`session:${session._id}`).emit('player_joined', payload);
}

function emitPlayerLeft(io, session, userId) {
  const payload = {
    session_id:    session._id.toString(),
    userId,
    playersJoined: (session.playersJoined || []).map(String)
  };
  io.of('/gaming').to(`city:${session.city}`).emit('session_updated', payload);
  io.of('/gaming').to(`session:${session._id}`).emit('player_left', payload);
}

function emitPlayerKicked(io, sessionId, city, targetUserId) {
  const payload = { session_id: sessionId, userId: String(targetUserId) };
  io.of('/gaming').to(`session:${sessionId}`).emit('player_removed', payload);
}

function emitPlayerMuted(io, sessionId, targetUserId, mutedUntil) {
  io.of('/gaming').to(`session:${sessionId}`).emit('player_muted', {
    session_id: sessionId,
    userId:     String(targetUserId),
    mutedUntil
  });
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

function emitNewReaction(io, sessionId, payload) {
  io.of('/gaming').to(`session:${sessionId}`).emit('reaction_updated', {
    session_id: sessionId,
    ...payload
  });
}

module.exports = {
  initSessionSocket,
  emitSessionCreated,
  emitPlayerJoined,
  emitPlayerLeft,
  emitPlayerKicked,
  emitPlayerMuted,
  emitNewMessage,
  emitSessionStarted,
  emitSessionExpired,
  emitSessionCancelled,
  emitPinnedMessage,
  emitNewReaction
};
