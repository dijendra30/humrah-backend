// server.js - PRODUCTION-READY SOCKET.IO CHAT SYSTEM
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);

// =============================================
// SOCKET.IO CONFIGURATION
// =============================================
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// =============================================
// IN-MEMORY STATE (NO DATABASE)
// =============================================
const userSockets = new Map();        // userId -> Set<socketId>
const socketToUser = new Map();        // socketId -> { userId, userName, chatId }
const chatRooms = new Map();           // chatId -> Set<userId>
const typingUsers = new Map();         // chatId -> Set<userId>

// =============================================
// MIDDLEWARE
// =============================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.set('io', io);

// =============================================
// SOCKET AUTHENTICATION MIDDLEWARE
// =============================================
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    
    if (!token) {
      return next(new Error('Authentication required'));
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Attach user info to socket
    socket.userId = decoded.userId;
    socket.userEmail = decoded.email;
    
    console.log(`✅ Socket authenticated: ${socket.userId}`);
    next();
  } catch (error) {
    console.error('❌ Socket authentication failed:', error.message);
    next(new Error('Invalid token'));
  }
});

// =============================================
// SOCKET.IO CONNECTION HANDLER
// =============================================
io.on('connection', async (socket) => {
  const userId = socket.userId;
  
  console.log(`🔌 User connected: ${userId} (${socket.id})`);
  
  // Track user socket
  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  userSockets.get(userId).add(socket.id);
  
  socketToUser.set(socket.id, { userId, chatId: null });
  
  // Emit user online status to all their active chats
  emitUserPresence(userId, true);
  
  // ===========================================
  // EVENT: join-chat
  // User joins a specific chat room
  // ===========================================
  socket.on('join-chat', async (data) => {
    try {
      const { chatId } = data;
      
      console.log(`📥 ${userId} joining chat: ${chatId}`);
      
      // Validate chat access
      const hasAccess = await validateChatAccess(userId, chatId);
      if (!hasAccess) {
        socket.emit('error', { message: 'Access denied to this chat' });
        return;
      }
      
      // Check if chat is expired
      const chatExpired = await isChatExpired(chatId);
      if (chatExpired) {
        socket.emit('chat-expired', { chatId });
        return;
      }
      
      // Join socket room
      socket.join(chatId);
      socket.chatId = chatId;
      socketToUser.set(socket.id, { userId, chatId });
      
      // Track room
      if (!chatRooms.has(chatId)) {
        chatRooms.set(chatId, new Set());
      }
      chatRooms.get(chatId).add(userId);
      
      // Notify others user joined
      socket.to(chatId).emit('user-joined', {
        userId,
        timestamp: new Date().toISOString()
      });
      
      // Send current online users
      const onlineUsers = Array.from(chatRooms.get(chatId));
      socket.emit('room-users', { chatId, onlineUsers });
      
      console.log(`✅ ${userId} joined chat ${chatId}`);
      
    } catch (error) {
      console.error('Join chat error:', error);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });
  
  // ===========================================
  // EVENT: message:send
  // User sends a message
  // ===========================================
  socket.on('message:send', async (data) => {
    try {
      const { chatId, content, tempId } = data;
      
      console.log(`📨 ${userId} sending message to ${chatId}`);
      
      // Validate
      if (!chatId || !content || !content.trim()) {
        socket.emit('message:error', { tempId, error: 'Invalid message' });
        return;
      }
      
      // Check chat access
      const hasAccess = await validateChatAccess(userId, chatId);
      if (!hasAccess) {
        socket.emit('message:error', { tempId, error: 'Access denied' });
        return;
      }
      
      // Check if expired
      const expired = await isChatExpired(chatId);
      if (expired) {
        socket.emit('message:error', { tempId, error: 'Chat expired' });
        return;
      }
      
      // Save message to database
      const Message = require('./models/Message');
      const message = await Message.create({
        chatId,
        senderId: userId,
        senderRole: 'USER',
        content: content.trim(),
        messageType: 'TEXT',
        timestamp: new Date()
      });
      
      // Populate sender
      await message.populate('senderId', 'firstName lastName profilePhoto');
      
      // Stop typing indicator
      stopTyping(chatId, userId);
      
      // Prepare message payload
      const messagePayload = {
        _id: message._id.toString(),
        chatId: message.chatId.toString(),
        senderId: message.senderId._id.toString(),
        senderName: `${message.senderId.firstName} ${message.senderId.lastName}`,
        senderPhoto: message.senderId.profilePhoto,
        content: message.content,
        messageType: message.messageType,
        timestamp: message.timestamp.toISOString(),
        tempId, // For client to match optimistic update
        status: 'SENT'
      };
      
      // Emit to sender (confirmation)
      socket.emit('message:sent', messagePayload);
      
      // Emit to other participants (delivery)
      const roomUsers = chatRooms.get(chatId) || new Set();
      const otherUsers = Array.from(roomUsers).filter(uid => uid !== userId);
      
      // Get online sockets for other users
      const deliveredTo = [];
      otherUsers.forEach(otherUserId => {
        const otherSockets = userSockets.get(otherUserId);
        if (otherSockets && otherSockets.size > 0) {
          otherSockets.forEach(socketId => {
            io.to(socketId).emit('message:received', messagePayload);
          });
          deliveredTo.push(otherUserId);
        }
      });
      
      // If delivered to any online user, emit delivery receipt
      if (deliveredTo.length > 0) {
        socket.emit('message:delivered', {
          messageId: message._id.toString(),
          deliveredTo,
          timestamp: new Date().toISOString()
        });
        
        // Update message status in DB
        message.isDelivered = true;
        message.deliveredAt = new Date();
        await message.save();
      }
      
      console.log(`✅ Message sent: ${message._id}, delivered to ${deliveredTo.length} users`);
      
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('message:error', { tempId: data.tempId, error: error.message });
    }
  });
  
  // ===========================================
  // EVENT: message:delivered
  // Client acknowledges message delivery
  // ===========================================
  socket.on('message:delivered', async (data) => {
    try {
      const { messageId, chatId } = data;
      
      const Message = require('./models/Message');
      const message = await Message.findById(messageId);
      
      if (message && message.chatId.toString() === chatId) {
        message.isDelivered = true;
        message.deliveredAt = new Date();
        await message.save();
        
        // Notify sender
        const senderSockets = userSockets.get(message.senderId.toString());
        if (senderSockets) {
          senderSockets.forEach(socketId => {
            io.to(socketId).emit('message:delivered', {
              messageId,
              timestamp: new Date().toISOString()
            });
          });
        }
      }
    } catch (error) {
      console.error('Delivery receipt error:', error);
    }
  });
  
  // ===========================================
  // EVENT: message:read
  // User reads a message
  // ===========================================
  socket.on('message:read', async (data) => {
    try {
      const { messageId, chatId } = data;
      
      const Message = require('./models/Message');
      const message = await Message.findById(messageId);
      
      if (message && message.chatId.toString() === chatId) {
        // Only mark as read if not sent by current user
        if (message.senderId.toString() !== userId) {
          message.isRead = true;
          message.readAt = new Date();
          await message.save();
          
          // Notify sender
          const senderSockets = userSockets.get(message.senderId.toString());
          if (senderSockets) {
            senderSockets.forEach(socketId => {
              io.to(socketId).emit('message:read', {
                messageId,
                readBy: userId,
                timestamp: new Date().toISOString()
              });
            });
          }
          
          console.log(`✅ Message ${messageId} marked as read by ${userId}`);
        }
      }
    } catch (error) {
      console.error('Read receipt error:', error);
    }
  });
  
  // ===========================================
  // EVENT: messages:read
  // Bulk mark messages as read
  // ===========================================
  socket.on('messages:read', async (data) => {
    try {
      const { chatId, messageIds } = data;
      
      const Message = require('./models/Message');
      
      // Update all messages
      await Message.updateMany(
        {
          _id: { $in: messageIds },
          chatId,
          senderId: { $ne: userId }
        },
        {
          $set: {
            isRead: true,
            readAt: new Date()
          }
        }
      );
      
      // Get unique senders
      const messages = await Message.find({ _id: { $in: messageIds } });
      const senders = [...new Set(messages.map(m => m.senderId.toString()))];
      
      // Notify each sender
      senders.forEach(senderId => {
        const senderSockets = userSockets.get(senderId);
        if (senderSockets) {
          senderSockets.forEach(socketId => {
            io.to(socketId).emit('messages:read', {
              chatId,
              messageIds,
              readBy: userId,
              timestamp: new Date().toISOString()
            });
          });
        }
      });
      
      console.log(`✅ ${messageIds.length} messages marked as read in chat ${chatId}`);
      
    } catch (error) {
      console.error('Bulk read error:', error);
    }
  });
  
  // ===========================================
  // EVENT: typing:start
  // User starts typing
  // ===========================================
  socket.on('typing:start', (data) => {
    try {
      const { chatId } = data;
      
      if (!typingUsers.has(chatId)) {
        typingUsers.set(chatId, new Set());
      }
      typingUsers.get(chatId).add(userId);
      
      // Broadcast to others in room
      socket.to(chatId).emit('user:typing', {
        userId,
        isTyping: true,
        chatId
      });
      
      // Auto-stop typing after 3 seconds
      setTimeout(() => {
        stopTyping(chatId, userId);
      }, 3000);
      
    } catch (error) {
      console.error('Typing start error:', error);
    }
  });
  
  // ===========================================
  // EVENT: typing:stop
  // User stops typing
  // ===========================================
  socket.on('typing:stop', (data) => {
    try {
      const { chatId } = data;
      stopTyping(chatId, userId);
    } catch (error) {
      console.error('Typing stop error:', error);
    }
  });
  
  // ===========================================
  // EVENT: leave-chat
  // User leaves chat room
  // ===========================================
  socket.on('leave-chat', (data) => {
    try {
      const { chatId } = data;
      
      socket.leave(chatId);
      
      if (chatRooms.has(chatId)) {
        chatRooms.get(chatId).delete(userId);
        if (chatRooms.get(chatId).size === 0) {
          chatRooms.delete(chatId);
        }
      }
      
      stopTyping(chatId, userId);
      
      socket.to(chatId).emit('user-left', { userId });
      
      console.log(`📤 ${userId} left chat ${chatId}`);
      
    } catch (error) {
      console.error('Leave chat error:', error);
    }
  });
  
  // ===========================================
  // EVENT: disconnect
  // User disconnects
  // ===========================================
  socket.on('disconnect', () => {
    try {
      // Remove from tracking
      if (userSockets.has(userId)) {
        userSockets.get(userId).delete(socket.id);
        if (userSockets.get(userId).size === 0) {
          userSockets.delete(userId);
          // User completely offline
          emitUserPresence(userId, false);
        }
      }
      
      socketToUser.delete(socket.id);
      
      // Clean up chat rooms
      const chatId = socket.chatId;
      if (chatId && chatRooms.has(chatId)) {
        chatRooms.get(chatId).delete(userId);
        stopTyping(chatId, userId);
        socket.to(chatId).emit('user-left', { userId });
      }
      
      console.log(`🔌 User disconnected: ${userId} (${socket.id})`);
      
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });
});

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Emit user presence (online/offline) to all their chats
 */
function emitUserPresence(userId, isOnline) {
  // Get all chats user is part of
  const RandomBookingChat = require('./models/RandomBookingChat');
  
  RandomBookingChat.find({ 'participants.userId': userId })
    .select('_id')
    .then(chats => {
      chats.forEach(chat => {
        io.to(chat._id.toString()).emit('user:presence', {
          userId,
          isOnline,
          timestamp: new Date().toISOString()
        });
      });
    })
    .catch(error => console.error('Presence emit error:', error));
}

/**
 * Stop typing indicator for user
 */
function stopTyping(chatId, userId) {
  if (typingUsers.has(chatId)) {
    typingUsers.get(chatId).delete(userId);
    io.to(chatId).emit('user:typing', {
      userId,
      isTyping: false,
      chatId
    });
  }
}

/**
 * Validate user has access to chat
 */
async function validateChatAccess(userId, chatId) {
  try {
    const RandomBookingChat = require('./models/RandomBookingChat');
    const chat = await RandomBookingChat.findById(chatId);
    
    if (!chat) return false;
    if (chat.isDeleted) return false;
    
    return chat.isParticipant(userId);
  } catch (error) {
    console.error('Access validation error:', error);
    return false;
  }
}

/**
 * Check if chat is expired
 */
async function isChatExpired(chatId) {
  try {
    const RandomBookingChat = require('./models/RandomBookingChat');
    const chat = await RandomBookingChat.findById(chatId);
    
    if (!chat) return true;
    
    return chat.isExpired();
  } catch (error) {
    console.error('Expiry check error:', error);
    return false;
  }
}

/**
 * Check if user is online
 */
function isUserOnline(userId) {
  return userSockets.has(userId) && userSockets.get(userId).size > 0;
}

/**
 * Get online users in chat
 */
function getOnlineUsersInChat(chatId) {
  const users = chatRooms.get(chatId);
  return users ? Array.from(users) : [];
}

// =============================================
// API ENDPOINTS FOR PRESENCE
// =============================================
app.get('/api/presence/:userId', (req, res) => {
  const { userId } = req.params;
  res.json({
    online: isUserOnline(userId),
    socketCount: userSockets.get(userId)?.size || 0
  });
});

app.get('/api/presence/chat/:chatId', (req, res) => {
  const { chatId } = req.params;
  const onlineUsers = getOnlineUsersInChat(chatId);
  res.json({
    chatId,
    onlineUsers,
    count: onlineUsers.length
  });
});

// =============================================
// DATABASE & SERVER STARTUP
// =============================================
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/humrah');
    console.log('✅ MongoDB Connected');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  }
};

connectDB();

// Import Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/random-booking', require('./routes/randomBooking'));
app.use('/api/admin', require('./routes/admin'));

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    socketConnections: io.engine.clientsCount,
    activeChats: chatRooms.size,
    onlineUsers: userSockets.size
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Humrah Server running on port ${PORT}`);
  console.log(`✅ Socket.IO enabled with authentication`);
  console.log(`📊 Features: Message States, Presence, Typing, Auto-expiry`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  server.close(async () => {
    await mongoose.connection.close();
    process.exit(0);
  });
});

module.exports = { app, server, io, isUserOnline, getOnlineUsersInChat };
