const RoomMember = require('../models/RoomMember');
const RoomMessage = require('../models/RoomMessage');
const HumrahRoom = require('../models/HumrahRoom');
const User = require('../models/User');

const redisService = require('../services/redisService');
const { rateLimiter } = require('../utils/socketAuth');

/**
 * Resolve a human-readable sender name for a socket.
 *
 * socket.userName is populated asynchronously by the io.use() auth middleware
 * (User.findById(...).then(...)), so on a fast first message it can still be
 * undefined. Fall back to a one-off DB lookup and cache it on the socket.
 */
async function resolveSenderName(socket) {
  if (socket.userName && socket.userName.trim()) return socket.userName.trim();
  try {
    const u = await User.findById(socket.userId).select('firstName lastName');
    if (u) {
      socket.userName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Member';
      return socket.userName;
    }
  } catch (err) {
    console.error('[ROOM_SOCKET] resolveSenderName error:', err.message);
  }
  return 'Member';
}

exports.initHumrahRoomSocket = (io) => {
  // Idempotency guard — initHumrahRoomSocket must register its connection
  // handler exactly once. A second call would double every room_message.
  if (io.__humrahRoomSocketInit) {
    console.warn('[ROOM_SOCKET] initHumrahRoomSocket called more than once — ignoring duplicate registration');
    return;
  }
  io.__humrahRoomSocketInit = true;

  io.on('connection', (socket) => {
    const userId = socket.userId;
    const userName = socket.userName;

    // Track which rooms this socket is currently active in
    const activeRooms = new Set();

    socket.on('join_room', async (data, callback) => {
      const { roomId } = data || {};
      if (!roomId) {
        if (typeof callback === 'function') callback({ error: 'Missing roomId' });
        return;
      }

      try {
        const member = await RoomMember.findOne({ roomId, userId, status: 'JOINED' });
        if (!member) {
          console.warn(`[ROOM_SOCKET] join_room DENIED userId=${userId} roomId=${roomId} (not a JOINED member)`);
          if (typeof callback === 'function') callback({ error: 'not_a_member' });
          socket.emit('room_error', { roomId, error: 'not_a_member' });
          return;
        }

        const roomChannel = `room:${roomId}`;
        socket.join(roomChannel);
        activeRooms.add(roomId);
        console.log(`[ROOM_SOCKET] joined roomId=${roomId} socketId=${socket.id} userId=${userId}`);

        socket.to(roomChannel).emit('room_member_joined', {
          userId,
          userName: await resolveSenderName(socket),
          timestamp: new Date().toISOString()
        });

        // Presence: 3 minutes (180s) ± 30s jitter
        await redisService.setWithJitter(`presence:room:${roomId}:${userId}`, { online: true, socketId: socket.id }, 180, 30);

        // Explicit acknowledgement so the client knows the join succeeded
        socket.emit('room_joined', { roomId });
        if (typeof callback === 'function') callback({ success: true, roomId });
      } catch (error) {
        console.error('[ROOM_SOCKET] error in join_room:', error);
        if (typeof callback === 'function') callback({ error: 'server_error' });
      }
    });

    socket.on('room_heartbeat', async (data) => {
      const { roomId } = data || {};
      if (!roomId || !activeRooms.has(roomId)) return;
      await redisService.setWithJitter(`presence:room:${roomId}:${userId}`, { online: true, socketId: socket.id }, 180, 30);
    });

    socket.on('leave_room', async (data) => {
      const { roomId } = data || {};
      if (!roomId) return;

      const roomChannel = `room:${roomId}`;
      socket.leave(roomChannel);
      activeRooms.delete(roomId);
      console.log(`[ROOM_SOCKET] left roomId=${roomId} socketId=${socket.id} userId=${userId}`);

      socket.to(roomChannel).emit('room_member_left', { userId, userName, timestamp: new Date().toISOString() });
      await redisService.releaseLock(`presence:room:${roomId}:${userId}`); // Remove presence
    });

    socket.on('disconnect', async () => {
      for (const roomId of activeRooms) {
        const roomChannel = `room:${roomId}`;
        socket.to(roomChannel).emit('room_member_left', { userId, userName, timestamp: new Date().toISOString() });
        await redisService.releaseLock(`presence:room:${roomId}:${userId}`);
      }
      activeRooms.clear();
    });

    socket.on('room_message', async (data, callback) => {
      const { roomId, content } = data || {};
      const clientMessageId = (data && typeof data.clientMessageId === 'string')
        ? data.clientMessageId.slice(0, 64)
        : null;
      if (!roomId || !content || !content.trim()) {
        if (typeof callback === 'function') callback({ error: 'Missing parameters' });
        return;
      }

      const sanitizedContent = content.trim();
      if (sanitizedContent.length > 1000) {
        if (typeof callback === 'function') callback({ error: 'Message too long (max 1000 characters)' });
        return;
      }

      // Basic abuse protection — 30 room messages / user / minute
      if (!rateLimiter.checkLimit(userId, 'room_message', 30)) {
        if (typeof callback === 'function') callback({ error: 'You are sending messages too fast. Please slow down.' });
        return;
      }

      try {
        const member = await RoomMember.findOne({ roomId, userId, status: 'JOINED' });
        if (!member) {
          if (typeof callback === 'function') callback({ error: 'Unauthorized to send messages to this room' });
          return;
        }

        const room = await HumrahRoom.findById(roomId);
        if (!room || ['INACTIVE', 'CLOSED'].includes(room.status)) {
          if (typeof callback === 'function') callback({ error: 'Room is closed or inactive' });
          return;
        }

        const buildEmitData = async (m) => ({
          _id: m._id.toString(),
          roomId: m.roomId.toString(),
          senderId: (m.senderId._id || m.senderId).toString(),
          senderName: await resolveSenderName(socket),
          content: m.content,
          createdAt: m.createdAt.toISOString(),
          messageType: m.messageType,
          clientMessageId: m.clientMessageId || clientMessageId || null
        });

        // Idempotency — a retry after reconnect must not create a second row.
        if (clientMessageId) {
          const existing = await RoomMessage.findOne({ roomId, senderId: userId, clientMessageId });
          if (existing) {
            console.log(`[ROOM_SOCKET] room_message dedup clientMessageId=${clientMessageId} → messageId=${existing._id}`);
            if (typeof callback === 'function') callback({ success: true, message: await buildEmitData(existing) });
            return;
          }
        }

        let msg;
        try {
          msg = await new RoomMessage({
            roomId,
            senderId: userId,
            messageType: 'TEXT',
            content: sanitizedContent,
            clientMessageId
          }).save();
        } catch (e) {
          // Unique index race — the retry landed while the first write was in flight.
          if (e && e.code === 11000 && clientMessageId) {
            const existing = await RoomMessage.findOne({ roomId, senderId: userId, clientMessageId });
            if (existing) {
              if (typeof callback === 'function') callback({ success: true, message: await buildEmitData(existing) });
              return;
            }
          }
          throw e;
        }

        room.lastMessageAt = new Date();
        await room.save();

        const emitData = await buildEmitData(msg);

        const roomChannel = `room:${roomId}`;
        // Broadcast to ALL OTHER members in the room (the sender gets it via the ack)
        socket.to(roomChannel).emit('room_message', emitData);
        console.log(`[ROOM_SOCKET] room_message persisted messageId=${emitData._id} roomId=${roomId} senderId=${userId}`);

        // Ack back to sender with the full persisted message
        if (typeof callback === 'function') callback({ success: true, message: emitData });
      } catch (error) {
        console.error('[ROOM_SOCKET] error in room_message:', error);
        if (typeof callback === 'function') callback({ error: 'Server error' });
      }
    });
  });
};
