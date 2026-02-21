// server.js - UPDATED WITH LEGAL + COMMUNITY GUIDELINES ENFORCEMENT
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
// SOCKET.IO
// =============================================
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
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
// IN-MEMORY PRESENCE & USER INFO TRACKING
// =============================================
const userPresence = new Map();
const chatUsers   = new Map();
const userInfo    = new Map();

// =============================================
// SOCKET AUTHENTICATION MIDDLEWARE
// =============================================
io.use((socket, next) => {
  try {
    let token = socket.handshake.auth?.token
      || socket.handshake.query?.token
      || socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      console.log('❌ Socket auth failed: No token provided');
      return next(new Error('Authentication error: No token provided'));
    }

    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_production';
    const decoded = jwt.verify(token, JWT_SECRET);

    socket.userId   = decoded.userId;
    socket.userRole = decoded.role || 'USER';

    const User = mongoose.model('User');
    User.findById(decoded.userId)
      .select('firstName lastName profilePhoto')
      .then(user => {
        if (user) {
          socket.userName  = `${user.firstName} ${user.lastName || ''}`.trim();
          socket.userPhoto = user.profilePhoto;
          userInfo.set(socket.userId, { name: socket.userName, photo: socket.userPhoto });
          console.log(`✅ Socket authenticated: ${socket.userName} (${socket.userId})`);
        }
      })
      .catch(err => {
        console.error('Error fetching socket user info:', err);
        socket.userName = 'User';
      });

    next();
  } catch (err) {
    console.log('❌ Socket auth failed:', err.message);
    if (err.name === 'TokenExpiredError') return next(new Error('Authentication error: Token expired'));
    if (err.name === 'JsonWebTokenError')  return next(new Error('Authentication error: Invalid token'));
    return next(new Error('Authentication error: ' + err.message));
  }
});

// =============================================
// SOCKET.IO CONNECTION HANDLER
// =============================================
io.on('connection', (socket) => {
  const userId   = socket.userId;
  const userName = socket.userName;

  console.log(`✅ User connected: ${userName} (${socket.id})`);

  userPresence.set(userId, {
    socketId: socket.id,
    status: 'ONLINE',
    lastSeen: new Date(),
    name: userName,
    photo: socket.userPhoto
  });

  io.emit('user-online', { userId, userName });

  // ── Join Chat ────────────────────────────────────────────────────────────
  socket.on('join-chat', async (data) => {
    try {
      const { chatId } = data;
      socket.join(chatId);
      socket.chatId = chatId;

      if (!chatUsers.has(chatId)) chatUsers.set(chatId, new Set());
      chatUsers.get(chatId).add(socket.id);

      console.log(`📥 ${userName} joined chat: ${chatId}`);
      socket.to(chatId).emit('user-joined', { userId, userName });

      // Deliver pending SENT messages
      const Message           = mongoose.model('Message');
      const RandomBookingChat = mongoose.model('RandomBookingChat');
      const chat = await RandomBookingChat.findById(chatId);

      if (chat) {
        const otherUserId = chat.participants.find(p => p.userId.toString() !== userId)?.userId;
        const pending = await Message.find({
          chatId,
          senderId: otherUserId,
          deliveryStatus: 'SENT'
        }).populate('senderId', 'firstName lastName profilePhoto');

        if (pending.length > 0) {
          console.log(`📬 Delivering ${pending.length} pending messages to ${userName}`);
          for (const msg of pending) {
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
            msg.deliveryStatus = 'DELIVERED';
            msg.deliveredAt = new Date();
            await msg.save();
            io.to(chatId).emit('message-delivered', {
              messageId: msg._id.toString(),
              deliveredTo: userId,
              deliveredAt: msg.deliveredAt.toISOString()
            });
          }
        }
      }
    } catch (error) {
      console.error('Join chat error:', error);
    }
  });

  // ── Leave Chat ───────────────────────────────────────────────────────────
  socket.on('leave-chat', (chatId) => {
    socket.leave(chatId);
    if (chatUsers.has(chatId)) {
      chatUsers.get(chatId).delete(socket.id);
      if (chatUsers.get(chatId).size === 0) chatUsers.delete(chatId);
    }
    console.log(`📤 ${userName} left chat: ${chatId}`);
    socket.to(chatId).emit('user-left', { userId, userName });
  });

  // ── Message Delivered ────────────────────────────────────────────────────
  socket.on('message-delivered', async (data) => {
    try {
      const { messageId, chatId } = data;
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      if (message && message.deliveryStatus === 'SENT') {
        message.deliveryStatus = 'DELIVERED';
        message.deliveredAt = new Date();
        await message.save();
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

  // ── Message Read ─────────────────────────────────────────────────────────
  socket.on('message-read', async (data) => {
    try {
      const { messageId, chatId } = data;
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      if (message && message.deliveryStatus !== 'READ') {
        message.deliveryStatus = 'READ';
        message.readAt = new Date();
        await message.save();
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

  // ── Typing Indicators ────────────────────────────────────────────────────
  socket.on('typing-start', ({ chatId }) =>
    socket.to(chatId).emit('user-typing', { userId, userName, isTyping: true }));

  socket.on('typing-stop', ({ chatId }) =>
    socket.to(chatId).emit('user-typing', { userId, userName, isTyping: false }));

  // ── Call Signaling ───────────────────────────────────────────────────────
  socket.on('initiate-call', async (data) => {
    try {
      const { chatId, callerId, calleeId, isAudioOnly } = data;
      console.log(`📞 Call initiated: ${userName} (${callerId}) → ${calleeId} (audio: ${isAudioOnly})`);
      const callerInfo = userInfo.get(callerId) || { name: userName, photo: socket.userPhoto };
      socket.to(chatId).emit('incoming-call', {
        chatId, callerId,
        callerName: callerInfo.name,
        callerPhoto: callerInfo.photo,
        isAudioOnly,
        timestamp: new Date().toISOString()
      });
      const calleePresence = userPresence.get(calleeId);
      if (!calleePresence || calleePresence.status === 'OFFLINE') {
        console.log(`📱 User offline — would send push notification`);
      }
    } catch (error) {
      console.error('Call initiation error:', error);
    }
  });

  socket.on('accept-call', ({ chatId, calleeId }) => {
    console.log(`✅ Call accepted by: ${userName} (${calleeId})`);
    const calleeInfo = userInfo.get(calleeId) || { name: userName, photo: socket.userPhoto };
    socket.to(chatId).emit('call-accepted', {
      calleeId,
      calleeName: calleeInfo.name,
      calleePhoto: calleeInfo.photo,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('reject-call', ({ chatId, calleeId }) => {
    console.log(`❌ Call rejected by: ${userName} (${calleeId})`);
    socket.to(chatId).emit('call-rejected', { calleeId, timestamp: new Date().toISOString() });
  });

  socket.on('end-call', ({ chatId }) => {
    console.log(`📵 Call ended in chat: ${chatId} by ${userName}`);
    socket.to(chatId).emit('call-ended', { endedBy: userId, timestamp: new Date().toISOString() });
  });

  // ── WebRTC Signaling ─────────────────────────────────────────────────────
  socket.on('webrtc-offer',          ({ chatId, offer })     => socket.to(chatId).emit('webrtc-offer',          { from: userId, offer }));
  socket.on('webrtc-answer',         ({ chatId, answer })    => socket.to(chatId).emit('webrtc-answer',         { from: userId, answer }));
  socket.on('webrtc-ice-candidate',  ({ chatId, candidate }) => socket.to(chatId).emit('webrtc-ice-candidate',  { from: userId, candidate }));

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${userName} (${socket.id})`);
    const user = userPresence.get(userId);
    if (user) {
      user.status  = 'OFFLINE';
      user.lastSeen = new Date();
    }
    io.emit('user-offline', { userId, userName, lastSeen: user?.lastSeen.toISOString() });

    if (socket.chatId && chatUsers.has(socket.chatId)) {
      chatUsers.get(socket.chatId).delete(socket.id);
      if (chatUsers.get(socket.chatId).size === 0) chatUsers.delete(socket.chatId);
      socket.to(socket.chatId).emit('user-left', { userId, userName });
    }
  });
});

// =============================================
// PRESENCE HELPERS
// =============================================
function isUserOnline(userId) {
  return userPresence.get(userId)?.status === 'ONLINE';
}
function getUserLastSeen(userId) {
  return userPresence.get(userId)?.lastSeen || null;
}
function getUserInfo(userId) {
  return userInfo.get(userId) || null;
}

global.isUserOnline   = isUserOnline;
global.getUserLastSeen = getUserLastSeen;
global.getUserInfo    = getUserInfo;

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
// ✅ MIDDLEWARE IMPORTS
// =============================================
const { authenticate }                = require('./middleware/auth');
const {
  enforceLegalAcceptance,
  enforceCommunityAcceptance
} = require('./middleware/enforceLegalAcceptance');

// =============================================
// ✅ ROUTE IMPORTS
// =============================================
const authRoutes          = require('./routes/auth');
const userRoutes          = require('./routes/users');
const legalRoutes         = require('./routes/legal');
const eventRoutes         = require('./routes/events');
const companionRoutes     = require('./routes/companions');
const bookingRoutes       = require('./routes/bookings');
const messageRoutes       = require('./routes/messages');
const postRoutes          = require('./routes/posts');
const spotlightRoutes     = require('./routes/spotlight.route');
const safetyReportRoutes  = require('./routes/safetyReports');
const profileRoutes       = require('./routes/profile');
const reviewRoutes        = require('./routes/reviews');
const paymentRoutes       = require('./routes/payment');
const { enforceLegalAcceptance, enforceCommunityAcceptance } = require('./middleware/enforceLegalAcceptance');


// =============================================
// ✅ PUBLIC ROUTES — no auth, no legal checks
// =============================================
app.use('/api/auth',  authRoutes);
app.use('/api/legal', legalRoutes);   // includes /community/version + /community/accept

// =============================================
// ✅ PROTECTED ROUTES — Terms & Privacy enforced on all
//
// Community Guidelines are enforced on booking, chat, and profile
// activation because those are the actions users can cause real-world
// harm with. Other protected routes (search, spotlight, etc.) only
// require Terms & Privacy acceptance, not community re-acceptance.
// =============================================

// ── User profile & settings — Terms & Privacy only ───────────────────────
app.use('/api/users',    authenticate, enforceLegalAcceptance, userRoutes);
app.use('/api/profile',  authenticate, enforceLegalAcceptance, profileRoutes);

// ── Core social routes — Terms & Privacy only ────────────────────────────
app.use('/api/events',    authenticate, enforceLegalAcceptance, eventRoutes);
app.use('/api/posts',     authenticate, enforceLegalAcceptance, postRoutes);
app.use('/api/spotlight', authenticate, enforceLegalAcceptance, spotlightRoutes);
app.use('/api/reviews',   authenticate, enforceLegalAcceptance, reviewRoutes);

// ── High-risk routes — Terms & Privacy + Community Guidelines enforced ───
// These are routes where an unaccepted community member could cause harm.
app.use('/api/companions',
  authenticate,
  enforceLegalAcceptance,
  enforceCommunityAcceptance,   // ✅ must have accepted community guidelines
  companionRoutes
);

app.use('/api/bookings',
  authenticate,
  enforceLegalAcceptance,
  enforceCommunityAcceptance,   // ✅ cannot book without community acceptance
  bookingRoutes
);

app.use('/api/messages',
  authenticate,
  enforceLegalAcceptance,
  enforceCommunityAcceptance,   // ✅ cannot chat without community acceptance
  messageRoutes
);

app.use('/api/random-booking',
  authenticate,
  enforceLegalAcceptance,
  enforceCommunityAcceptance,   // ✅
  require('./routes/randomBooking')
);

// ── Safety reports — Terms & Privacy only (users must be able to report) ──
app.use('/api/safety',   authenticate, enforceLegalAcceptance, safetyReportRoutes);

// ── Payment — Terms & Privacy + Community (financial transactions) ────────
app.use('/api/payment',
  authenticate,
  enforceLegalAcceptance,
  enforceCommunityAcceptance,   // ✅ cannot transact without community acceptance
  paymentRoutes
);

// ── Calls — Terms & Privacy + Community ──────────────────────────────────
app.use('/api/agora',
  authenticate,
  enforceLegalAcceptance,
  enforceCommunityAcceptance,   // ✅
  require('./routes/agora')
);
app.use('/api/voice-call',
  authenticate,
  enforceLegalAcceptance,
  enforceCommunityAcceptance,   // ✅
  require('./routes/voice-call')
);

// ── Verification — Terms & Privacy only ──────────────────────────────────
app.use('/api/verification',
  authenticate,
  enforceLegalAcceptance,
  require('./routes/verification')
);

// ── Admin routes — no legal enforcement needed for admin duties ───────────
app.use('/api/admin', authenticate, require('./routes/admin'));

// =============================================
// CRON JOBS
// =============================================
require('./cronJobs');

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Humrah API is running',
    socketConnections: io.engine.clientsCount,
    activeChats: chatUsers.size,
    onlineUsers: Array.from(userPresence.values()).filter(u => u.status === 'ONLINE').length,
    communityGuidelinesVersion: process.env.COMMUNITY_GUIDELINES_VERSION || '1.0'
  });
});

// =============================================
// ERROR HANDLER
// =============================================
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Humrah Server running on port ${PORT}`);
  console.log(`✅ Socket.IO enabled with:`);
  console.log(`   - Voice/Video calls with user info`);
  console.log(`   - Delivery receipts (SENT → DELIVERED → READ)`);
  console.log(`   - Typing indicators`);
  console.log(`   - Presence tracking (online/offline)`);
  console.log(`   - JWT authentication`);
  console.log(`✅ Legal compliance enforcement active`);
  console.log(`✅ Community Guidelines v${process.env.COMMUNITY_GUIDELINES_VERSION || '1.0'} enforcement active`);
});

// =============================================
// GRACEFUL SHUTDOWN
// =============================================
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
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

module.exports = { app, server, io };
