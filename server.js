// server.js - PRODUCTION-READY SOCKET.IO WITH DELIVERY RECEIPTS + PRESENCE + TYPING
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

// ✅ Socket.IO with authentication
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Make io available to routes
app.set('io', io);

// =============================================
// IN-MEMORY PRESENCE TRACKING
// =============================================
const userPresence = new Map();
// userId -> { socketId, status: 'ONLINE'|'OFFLINE', lastSeen: Date }

const chatUsers = new Map();
// chatId -> Set of socketIds

// =============================================
// SOCKET AUTHENTICATION MIDDLEWARE
// =============================================
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    console.log('❌ Socket auth failed: No token');
    return next(new Error('Authentication error: No token provided'));
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_change_in_production');
    socket.userId = decoded.userId;
    socket.userName = decoded.firstName + ' ' + (decoded.lastName || '');
    
    console.log(`✅ Socket authenticated: ${socket.userId}`);
    next();
  } catch (err) {
    console.log('❌ Socket auth failed: Invalid token');
    return next(new Error('Authentication error: Invalid token'));
  }
});

// =============================================
// SOCKET.IO CONNECTION HANDLER
// =============================================
io.on('connection', (socket) => {
  const userId = socket.userId;
  const userName = socket.userName;
  
  console.log(`✅ User connected: ${userName} (${socket.id})`);
  
  // ✅ Mark user as ONLINE
  userPresence.set(userId, {
    socketId: socket.id,
    status: 'ONLINE',
    lastSeen: new Date()
  });
  
  // Broadcast user online status
  io.emit('user-online', {
    userId,
    userName
  });
  
  // ==================== JOIN CHAT ====================
  socket.on('join-chat', async (data) => {
    try {
      const { chatId } = data;
      
      socket.join(chatId);
      socket.chatId = chatId;
      
      // Track user in room
      if (!chatUsers.has(chatId)) {
        chatUsers.set(chatId, new Set());
      }
      chatUsers.get(chatId).add(socket.id);
      
      console.log(`📥 ${userName} joined chat: ${chatId}`);
      
      // Notify other user in chat
      socket.to(chatId).emit('user-joined', {
        userId,
        userName
      });
      
      // ✅ Deliver any pending SENT messages
      const Message = mongoose.model('Message');
      const RandomBookingChat = mongoose.model('RandomBookingChat');
      
      const chat = await RandomBookingChat.findById(chatId);
      if (chat) {
        const otherUserId = chat.participants.find(p => 
          p.userId.toString() !== userId
        )?.userId;
        
        // Find pending messages sent to this user
        const pending = await Message.find({
          chatId,
          senderId: otherUserId,
          deliveryStatus: 'SENT'
        }).populate('senderId', 'firstName lastName profilePhoto');
        
        if (pending.length > 0) {
          console.log(`📬 Delivering ${pending.length} pending messages to ${userName}`);
          
          pending.forEach(async (msg) => {
            // Emit to user
            socket.emit('new-message', {
              _id: msg._id.toString(),
              chatId: msg.chatId.toString(),
              senderId: msg.senderId._id.toString(),
              senderIdRaw: {
                _id: msg.senderId._id.toString(),
                firstName: msg.senderId.firstName,
                lastName: msg.senderId.lastName,
                profilePhoto: msg.senderId.profilePhoto
              },
              content: msg.content,
              messageType: msg.messageType,
              timestamp: msg.timestamp.toISOString(),
              deliveryStatus: 'SENT'
            });
            
            // Update to DELIVERED
            msg.deliveryStatus = 'DELIVERED';
            msg.deliveredAt = new Date();
            await msg.save();
            
            // Notify sender of delivery
            io.to(chatId).emit('message-delivered', {
              messageId: msg._id.toString(),
              deliveredTo: userId,
              deliveredAt: msg.deliveredAt.toISOString()
            });
          });
        }
      }
      
    } catch (error) {
      console.error('Join chat error:', error);
    }
  });
  
  // ==================== LEAVE CHAT ====================
  socket.on('leave-chat', (chatId) => {
    socket.leave(chatId);
    
    if (chatUsers.has(chatId)) {
      chatUsers.get(chatId).delete(socket.id);
      if (chatUsers.get(chatId).size === 0) {
        chatUsers.delete(chatId);
      }
    }
    
    console.log(`📤 ${userName} left chat: ${chatId}`);
    
    socket.to(chatId).emit('user-left', {
      userId,
      userName
    });
  });
  
  // ==================== MESSAGE DELIVERED ====================
  socket.on('message-delivered', async (data) => {
    try {
      const { messageId, chatId } = data;
      
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      
      if (message && message.deliveryStatus === 'SENT') {
        message.deliveryStatus = 'DELIVERED';
        message.deliveredAt = new Date();
        await message.save();
        
        // Notify sender
        socket.to(chatId).emit('message-delivered', {
          messageId,
          deliveredTo: userId,
          deliveredAt: message.deliveredAt.toISOString()
        });
        
        console.log(`✅ Message ${messageId} delivered to ${userName}`);
      }
    } catch (error) {
      console.error('Message delivered error:', error);
    }
  });
  
  // ==================== MESSAGE READ ====================
  socket.on('message-read', async (data) => {
    try {
      const { messageId, chatId } = data;
      
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      
      if (message && message.deliveryStatus !== 'READ') {
        message.deliveryStatus = 'READ';
        message.readAt = new Date();
        await message.save();
        
        // Notify sender
        socket.to(chatId).emit('message-read', {
          messageId,
          readBy: userId,
          readAt: message.readAt.toISOString()
        });
        
        console.log(`✅ Message ${messageId} read by ${userName}`);
      }
    } catch (error) {
      console.error('Message read error:', error);
    }
  });
  
  // ==================== TYPING INDICATORS ====================
  socket.on('typing-start', (data) => {
    const { chatId } = data;
    
    socket.to(chatId).emit('user-typing', {
      userId,
      userName,
      isTyping: true
    });
    
    console.log(`⌨️ ${userName} started typing in ${chatId}`);
  });
  
  socket.on('typing-stop', (data) => {
    const { chatId } = data;
    
    socket.to(chatId).emit('user-typing', {
      userId,
      userName,
      isTyping: false
    });
    
    console.log(`⌨️ ${userName} stopped typing in ${chatId}`);
  });
  
  // ==================== DISCONNECT ====================
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${userName} (${socket.id})`);
    
    // ✅ Mark user as OFFLINE
    const user = userPresence.get(userId);
    if (user) {
      user.status = 'OFFLINE';
      user.lastSeen = new Date();
    }
    
    // Broadcast user offline status
    io.emit('user-offline', {
      userId,
      userName,
      lastSeen: user?.lastSeen.toISOString()
    });
    
    // Remove from chat rooms
    if (socket.chatId && chatUsers.has(socket.chatId)) {
      chatUsers.get(socket.chatId).delete(socket.id);
      if (chatUsers.get(socket.chatId).size === 0) {
        chatUsers.delete(socket.chatId);
      }
      
      socket.to(socket.chatId).emit('user-left', {
        userId,
        userName
      });
    }
  });
});

// =============================================
// PRESENCE HELPER FUNCTIONS
// =============================================
function isUserOnline(userId) {
  const presence = userPresence.get(userId);
  return presence?.status === 'ONLINE';
}

function getUserLastSeen(userId) {
  const presence = userPresence.get(userId);
  return presence?.lastSeen || null;
}

// Make available globally
global.isUserOnline = isUserOnline;
global.getUserLastSeen = getUserLastSeen;

// =============================================
// DATABASE CONNECTION
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

// =============================================
// ROUTES
// =============================================
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const eventRoutes = require('./routes/events');
const companionRoutes = require('./routes/companions');
const bookingRoutes = require('./routes/bookings');
const messageRoutes = require('./routes/messages');
const postRoutes = require('./routes/posts');
const spotlightRoutes = require('./routes/spotlight.route');
const safetyReportRoutes = require('./routes/safetyReports');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/companions', companionRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/spotlight', spotlightRoutes);
app.use('/api/safety', safetyReportRoutes);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/random-booking', require('./routes/randomBooking'));

// Cron jobs
require('./cronJobs');

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Humrah API is running',
    socketConnections: io.engine.clientsCount,
    activeChats: chatUsers.size,
    onlineUsers: Array.from(userPresence.values()).filter(u => u.status === 'ONLINE').length
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    success: false, 
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Humrah Server running on port ${PORT}`);
  console.log(`✅ Socket.IO enabled with:`);
  console.log(`   - Delivery receipts (SENT → DELIVERED → READ)`);
  console.log(`   - Typing indicators`);
  console.log(`   - Presence tracking (online/offline)`);
  console.log(`   - JWT authentication`);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} signal received: closing HTTP server`);
  
  server.close(async () => {
    console.log('HTTP server closed');
    
    try {
      await mongoose.connection.close();
      console.log('MongoDB connection closed');
      process.exit(0);
    } catch (err) {
      console.error('Error closing MongoDB connection:', err);
      process.exit(1);
    }
  });
  
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

module.exports = { app, server, io };
