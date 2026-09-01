const RoomMember = require('../models/RoomMember');
const RoomMessage = require('../models/RoomMessage');
const HumrahRoom = require('../models/HumrahRoom');

const redisService = require('../services/redisService');

exports.initHumrahRoomSocket = (io) => {
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const userName = socket.userName;
    
    // Track which rooms this socket is currently active in
    const activeRooms = new Set();

    socket.on('join_room', async (data) => {
      const { roomId } = data;
      if (!roomId) return;

      try {
        const member = await RoomMember.findOne({ roomId, userId, status: 'JOINED' });
        if (!member) {
          console.warn(`[HUMRAH_ROOM] Unauthorized join_room socket attempt. User ${userId} is not a joined member of room ${roomId}`);
          return;
        }

        const roomChannel = `room:${roomId}`;
        socket.join(roomChannel);
        activeRooms.add(roomId);
        console.log(`[HUMRAH_ROOM] socketId=${socket.id} userId=${userId} joined room channel ${roomChannel}`);

        socket.to(roomChannel).emit('room_member_joined', { userId, userName, timestamp: new Date().toISOString() });
        
        // Presence: 3 minutes (180s) ± 30s jitter
        await redisService.setWithJitter(`presence:room:${roomId}:${userId}`, { online: true, socketId: socket.id }, 180, 30);
      } catch (error) {
        console.error('[HUMRAH_ROOM] Error in join_room:', error);
      }
    });

    socket.on('room_heartbeat', async (data) => {
      const { roomId } = data;
      if (!roomId || !activeRooms.has(roomId)) return;
      await redisService.setWithJitter(`presence:room:${roomId}:${userId}`, { online: true, socketId: socket.id }, 180, 30);
    });

    socket.on('leave_room', async (data) => {
      const { roomId } = data;
      if (!roomId) return;
      
      const roomChannel = `room:${roomId}`;
      socket.leave(roomChannel);
      activeRooms.delete(roomId);
      
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
      const { roomId, content } = data;
      if (!roomId || !content) {
        if (typeof callback === 'function') callback({ error: 'Missing parameters' });
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

        const msg = new RoomMessage({
          roomId,
          senderId: userId,
          messageType: 'TEXT',
          content
        });
        await msg.save();

        room.lastMessageAt = new Date();
        await room.save();

        const emitData = {
          _id: msg._id.toString(),
          roomId: msg.roomId.toString(),
          senderId: msg.senderId.toString(),
          senderName: userName,
          content: msg.content,
          messageType: msg.messageType,
          createdAt: msg.createdAt.toISOString()
        };

        const roomChannel = `room:${roomId}`;
        socket.to(roomChannel).emit('room_message', emitData);

        if (typeof callback === 'function') callback({ success: true, message: emitData });
      } catch (error) {
        console.error('[HUMRAH_ROOM] Error in room_message:', error);
        if (typeof callback === 'function') callback({ error: 'Server error' });
      }
    });
  });
};
