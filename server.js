// server.js - WITH SOCKET.IO + TYPING INDICATORS
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);

// ✅ Socket.IO with typing support
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

// ✅ Track users in chat rooms
const chatUsers = new Map(); // chatId -> Set of socketIds

// ✅ Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  
  // Join chat room
  socket.on('join-chat', (data) => {
    const { chatId, userId, userName } = data;
    
    socket.join(chatId);
    socket.chatId = chatId;
    socket.userId = userId;
    socket.userName = userName;
    
    // Track user in room
    if (!chatUsers.has(chatId)) {
      chatUsers.set(chatId, new Set());
    }
    chatUsers.get(chatId).add(socket.id);
    
    console.log(`📥 ${userName} (${socket.id}) joined chat: ${chatId}`);
    
    // Notify others user joined
    socket.to(chatId).emit('user-joined', {
      userId,
      userName
    });
  });
  
  // Leave chat room
  socket.on('leave-chat', (chatId) => {
    socket.leave(chatId);
    
    if (chatUsers.has(chatId)) {
      chatUsers.get(chatId).delete(socket.id);
      if (chatUsers.get(chatId).size === 0) {
        chatUsers.delete(chatId);
      }
    }
    
    console.log(`📤 User ${socket.id} left chat: ${chatId}`);
  });
  
  // ✅ Typing indicator - START
  socket.on('typing-start', (data) => {
    const { chatId, userId, userName } = data;
    
    // Broadcast to others in room (not self)
    socket.to(chatId).emit('user-typing', {
      userId,
      userName,
      isTyping: true
    });
    
    console.log(`⌨️ ${userName} started typing in ${chatId}`);
  });
  
  // ✅ Typing indicator - STOP
  socket.on('typing-stop', (data) => {
    const { chatId, userId, userName } = data;
    
    socket.to(chatId).emit('user-typing', {
      userId,
      userName,
      isTyping: false
    });
    
    console.log(`⌨️ ${userName} stopped typing in ${chatId}`);
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    // Remove from chat users
    if (socket.chatId && chatUsers.has(socket.chatId)) {
      chatUsers.get(socket.chatId).delete(socket.id);
      if (chatUsers.get(socket.chatId).size === 0) {
        chatUsers.delete(socket.chatId);
      }
      
      // Notify others user left
      socket.to(socket.chatId).emit('user-left', {
        userId: socket.userId,
        userName: socket.userName
      });
    }
    
    console.log('❌ User disconnected:', socket.id);
  });
});

// Database Connection
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
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const eventRoutes = require('./routes/events');
const companionRoutes = require('./routes/companions');
const bookingRoutes = require('./routes/bookings');
const messageRoutes = require('./routes/messages');
const postRoutes = require('./routes/posts');
const spotlightRoutes = require('./routes/spotlight.route');
const safetyReportRoutes = require('./routes/safetyReports');

// Use Routes
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
    activeChats: chatUsers.size
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
  console.log(`✅ Socket.IO enabled with typing indicators`);
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
