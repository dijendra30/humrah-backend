/**
 * sockets/movieChatSocket.js
 *
 * Socket.IO namespace: /movie-chat
 * Handles real-time messaging for Movie Session chat rooms.
 *
 * EVENTS RECEIVED:
 *   join-movie-chat    { chatId }   → join room "movie-chat:{chatId}"
 *   leave-movie-chat   { chatId }   → leave room
 *   movie-typing-start { chatId }   → broadcast typing = true  to room
 *   movie-typing-stop  { chatId }   → broadcast typing = false to room
 *
 * EVENTS EMITTED:
 *   movie-new-message  { senderId, senderName, senderPhoto, text, timestamp }
 *   movie-typing       { userId, userName, isTyping }
 *   movie-user-joined  { userId, userName }
 *   movie-user-left    { userId, userName }
 *
 * Call initMovieChatSocket(io) from server.js after initSessionSocket.
 * Call emitMovieMessage(io, chatId, message) from movieSessionController/service.
 */
'use strict';

const jwt = require('jsonwebtoken');

function verifyToken(token) {
  if (!token) throw new Error('No token');
  const raw = token.startsWith('Bearer ') ? token.slice(7) : token;
  const decoded = jwt.verify(raw, process.env.JWT_SECRET || 'fallback_secret_change_in_production');
  return {
    userId:   (decoded.userId || decoded._id || '').toString(),
    username: decoded.username || 'User',
  };
}

function initMovieChatSocket(io) {
  const ns = io.of('/movie-chat');

  // ── Auth middleware ──────────────────────────────────────────────────────────
  ns.use((socket, next) => {
    try {
      const raw = socket.handshake.auth?.token || '';
      socket.data.user = verifyToken(raw);
      next();
    } catch (e) {
      next(new Error('Auth failed: ' + e.message));
    }
  });

  ns.on('connection', (socket) => {
    const { userId, username } = socket.data.user;

    // ── join-movie-chat ────────────────────────────────────────────────────────
    socket.on('join-movie-chat', ({ chatId } = {}) => {
      if (!chatId) return;
      const room = `movie-chat:${chatId}`;
      socket.join(room);
      socket.data.chatId = chatId;
      socket.to(room).emit('movie-user-joined', { userId, userName: username });
    });

    // ── leave-movie-chat ───────────────────────────────────────────────────────
    socket.on('leave-movie-chat', ({ chatId } = {}) => {
      if (!chatId) return;
      const room = `movie-chat:${chatId}`;
      socket.leave(room);
      socket.to(room).emit('movie-user-left', { userId, userName: username });
    });

    // ── movie-typing-start ─────────────────────────────────────────────────────
    socket.on('movie-typing-start', ({ chatId } = {}) => {
      const room = `movie-chat:${chatId || socket.data.chatId}`;
      if (!room.includes(':')) return;
      socket.to(room).emit('movie-typing', { userId, userName: username, isTyping: true });
    });

    // ── movie-typing-stop ──────────────────────────────────────────────────────
    socket.on('movie-typing-stop', ({ chatId } = {}) => {
      const room = `movie-chat:${chatId || socket.data.chatId}`;
      if (!room.includes(':')) return;
      socket.to(room).emit('movie-typing', { userId, userName: username, isTyping: false });
    });

    // ── disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const chatId = socket.data.chatId;
      if (chatId) {
        socket.to(`movie-chat:${chatId}`).emit('movie-user-left', { userId, userName: username });
        socket.to(`movie-chat:${chatId}`).emit('movie-typing', { userId, userName: username, isTyping: false });
      }
    });
  });

  return ns;
}

/**
 * Call this from movieSessionService.sendMessage() after saving to DB.
 *
 * message shape:
 *   { senderId, senderName, senderPhoto, text, timestamp }
 */
function emitMovieMessage(io, chatId, message) {
  io.of('/movie-chat')
    .to(`movie-chat:${chatId}`)
    .emit('movie-new-message', message);
}

module.exports = { initMovieChatSocket, emitMovieMessage };
