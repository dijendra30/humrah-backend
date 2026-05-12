// server.js - UPDATED WITH LEGAL ACCEPTANCE ENFORCEMENT + PRODUCTION SECURITY HARDENING
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const { globalLimiter } = require('./middleware/rateLimitMiddleware');

dotenv.config();

// =============================================
// STARTUP ENV VALIDATION — fail fast, fail loud
// =============================================
const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
  'MONGODB_URI',
  'AGORA_APP_ID',
  'AGORA_APP_CERTIFICATE',
  'OTP_PEPPER',
];
const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('\n❌ SERVER STARTUP FAILED — missing required environment variables:');
  missingVars.forEach(v => console.error(`   • ${v}`));
  console.error('\nAdd these to your .env file and restart.\n');
  console.error('Generate OTP_PEPPER: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ✅ Initialize Firebase Admin SDK (MUST be before any push notification calls)
try {
  require('./config/firebase');
  console.log('✅ Firebase Admin SDK initialized');
} catch (err) {
  console.error('❌ Firebase init failed:', err.message);
}

const app = express();
const server = http.createServer(app);

// =============================================
// CORS ORIGIN WHITELIST
// Android Retrofit does NOT send Origin headers for native requests.
// The whitelist matters for:
//   - Browser-based pages (reset-password.html)
//   - Future web dashboard
//   - Any browser fetch calls
// null = allows requests with no Origin (native Android, Postman dev testing)
// =============================================
const ALLOWED_ORIGINS = [
  // Add your web dashboard domain here when you have one
  // e.g. 'https://admin.humrah.in'
  'https://humrah.in',
  'https://www.humrah.in',
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no Origin header (native Android, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // In development, allow localhost
    if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false, // set true only if you add cookie auth later
};

// ✅ Socket.IO with same CORS whitelist
// Android Socket.IO client does NOT send Origin — null check handles that.
const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost')) {
        return callback(null, true);
      }
      return callback(new Error(`Socket CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST"],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// =============================================
// TRUST PROXY — CRITICAL for Render
// Set to true to trust ALL X-Forwarded-For hops.
// Render sits behind multiple proxy layers — setting this to 1 (one hop)
// causes req.ip to resolve to Render's internal proxy IP instead of the
// real client IP, making ALL rate limiters key off the same IP and
// therefore never trigger. true = trust the leftmost IP in X-Forwarded-For.
// =============================================
app.set('trust proxy', true);

// =============================================
// SECURITY MIDDLEWARE
// Applied in this order deliberately.
// =============================================

// 1. Remove X-Powered-By header (don't advertise Express)
app.disable('x-powered-by');

// 2. Helmet: sets secure HTTP headers
//    - X-Content-Type-Options: nosniff
//    - X-Frame-Options: SAMEORIGIN
//    - Strict-Transport-Security (HSTS)
//    - Referrer-Policy
//    - X-DNS-Prefetch-Control
//    CSP is configured specifically (not disabled) to protect reset-password.html
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],                    // no inline scripts on reset page
      styleSrc:       ["'self'", "'unsafe-inline'"], // allow inline styles for the HTML page
      imgSrc:         ["'self'", "data:", "https://res.cloudinary.com"], // profile photos
      connectSrc:     ["'self'"],
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      frameSrc:       ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // keep false — Agora/Socket.IO need this off
  hsts: {
    maxAge: 31536000,       // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// 3. CORS
app.use(cors(corsOptions));

// 4. mongoSanitize: strips $gt, $where, etc. from req.body/query/params
//    Prevents NoSQL injection like { email: { "$gt": "" } }
app.use(mongoSanitize());

// 5. hpp: prevent HTTP Parameter Pollution (duplicate params attack)
app.use(hpp());

// 6. Global rate limiter — 100 req / 15 min per IP
//    trust proxy must be set BEFORE this runs so ipKeyGenerator gets real IP
app.use(globalLimiter);

// =============================================
// BODY PARSING — tiered limits
//
// Default: 100kb — safe for all JSON API requests.
// Exceptions below: 3 routes send base64-encoded images in JSON body.
//   - POST /api/users/upload-profile-photo-base64
//   - POST /api/users/submit-verification-photo-base64
//   - POST /api/posts (imageBase64 field)
//
// Base64 inflates size by ~1.37x. A 1MB photo becomes ~1.4MB base64.
// 5mb covers up to ~3.6MB raw image — reasonable for mobile camera output.
// Multer-based routes (food, verification video, multipart photo) are
// NOT affected by this — multer has its own independent fileSize limits.
// =============================================

// Per-route overrides for base64 upload endpoints — applied BEFORE global parser
app.use('/api/users/upload-profile-photo-base64',    express.json({ limit: '5mb' }));
app.use('/api/users/submit-verification-photo-base64', express.json({ limit: '5mb' }));
app.use('/api/posts',                                express.json({ limit: '5mb' }));

// Global limit for everything else
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Make io available to routes
app.set('io', io);

// =============================================
// ✅ SERVE STATIC PUBLIC FILES
// Must come BEFORE any route registration
// =============================================
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// ✅ CLEAN URL: GET /reset-password?token=XYZ
// =============================================
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// =============================================
// IN-MEMORY PRESENCE & USER INFO TRACKING
// =============================================
const userPresence = new Map();
const chatUsers    = new Map();
const userInfo     = new Map();

// =============================================
// SOCKET AUTHENTICATION MIDDLEWARE
// =============================================
io.use((socket, next) => {
  try {
    let token = socket.handshake.auth?.token;
    if (!token) token = socket.handshake.query?.token;
    if (!token) token = socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      console.log('❌ Socket auth failed: No token provided');
      return next(new Error('Authentication error: No token provided'));
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      console.error('[server.js] JWT_SECRET env var is not set. Rejecting socket connection.');
      return next(new Error('Authentication error: Server misconfiguration'));
    }
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
      .catch(err => { console.error('Error fetching user info:', err); socket.userName = 'User'; });

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
    status:   'ONLINE',
    lastSeen: new Date(),
    name:     userName,
    photo:    socket.userPhoto
  });

  io.emit('user-online', { userId, userName });

  // ==================== JOIN CHAT ====================
  socket.on('join-chat', async (data) => {
    try {
      const { chatId } = data;
      socket.join(chatId);
      socket.chatId = chatId;
      if (!chatUsers.has(chatId)) chatUsers.set(chatId, new Set());
      chatUsers.get(chatId).add(socket.id);
      console.log(`📥 ${userName} joined chat: ${chatId}`);
      socket.to(chatId).emit('user-joined', { userId, userName });

      const Message           = mongoose.model('Message');
      const RandomBookingChat = mongoose.model('RandomBookingChat');
      const chat = await RandomBookingChat.findById(chatId);
      if (chat) {
        const otherUserId = chat.participants.find(p => p.userId.toString() !== userId)?.userId;
        const pending = await Message.find({
          chatId, senderId: otherUserId, deliveryStatus: 'SENT'
        }).populate('senderId', 'firstName lastName profilePhoto');

        if (pending.length > 0) {
          console.log(`📬 Delivering ${pending.length} pending messages to ${userName}`);
          for (const msg of pending) {
            socket.emit('new-message', {
              _id: msg._id.toString(), chatId: msg.chatId.toString(),
              senderId: msg.senderId._id.toString(),
              senderIdRaw: {
                _id: msg.senderId._id.toString(), firstName: msg.senderId.firstName,
                lastName: msg.senderId.lastName, profilePhoto: msg.senderId.profilePhoto
              },
              content: msg.content, messageType: msg.messageType,
              timestamp: msg.timestamp.toISOString(), deliveryStatus: 'SENT'
            });
            msg.deliveryStatus = 'DELIVERED';
            msg.deliveredAt    = new Date();
            await msg.save();
            io.to(chatId).emit('message-delivered', {
              messageId: msg._id.toString(), deliveredTo: userId,
              deliveredAt: msg.deliveredAt.toISOString()
            });
          }
        }
      }
    } catch (error) { console.error('Join chat error:', error); }
  });

  // ==================== LEAVE CHAT ====================
  socket.on('leave-chat', (chatId) => {
    socket.leave(chatId);
    if (chatUsers.has(chatId)) {
      chatUsers.get(chatId).delete(socket.id);
      if (chatUsers.get(chatId).size === 0) chatUsers.delete(chatId);
    }
    console.log(`📤 ${userName} left chat: ${chatId}`);
    socket.to(chatId).emit('user-left', { userId, userName });
  });

  // ==================== MESSAGE DELIVERED ====================
  socket.on('message-delivered', async (data) => {
    try {
      const { messageId, chatId } = data;
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      if (message && message.deliveryStatus === 'SENT') {
        message.deliveryStatus = 'DELIVERED';
        message.deliveredAt    = new Date();
        await message.save();
        socket.to(chatId).emit('message-delivered', {
          messageId, deliveredTo: userId, deliveredAt: message.deliveredAt.toISOString()
        });
        console.log(`✅ Message ${messageId} delivered to ${userName}`);
      }
    } catch (error) { console.error('Message delivered error:', error); }
  });

  // ==================== MESSAGE READ ====================
  socket.on('message-read', async (data) => {
    try {
      const { messageId, chatId } = data;
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      if (message && message.deliveryStatus !== 'READ') {
        message.deliveryStatus = 'READ';
        message.readAt         = new Date();
        await message.save();
        socket.to(chatId).emit('message-read', {
          messageId, readBy: userId, readAt: message.readAt.toISOString()
        });
        console.log(`✅ Message ${messageId} read by ${userName}`);
      }
    } catch (error) { console.error('Message read error:', error); }
  });

  // ==================== TYPING INDICATORS ====================
  socket.on('typing-start', ({ chatId }) => {
    socket.to(chatId).emit('user-typing', { userId, userName, isTyping: true });
  });
  socket.on('typing-stop', ({ chatId }) => {
    socket.to(chatId).emit('user-typing', { userId, userName, isTyping: false });
  });

  // ==================== CALL SIGNALING ====================
  socket.on('initiate-call', async (data) => {
    try {
      const { chatId, callerId, calleeId, isAudioOnly } = data;
      console.log(`📞 Call initiated: ${userName} (${callerId}) → ${calleeId} (audio: ${isAudioOnly})`);
      const callerInfo = userInfo.get(callerId) || { name: userName, photo: socket.userPhoto };
      socket.to(chatId).emit('incoming-call', {
        chatId, callerId, callerName: callerInfo.name, callerPhoto: callerInfo.photo,
        isAudioOnly, timestamp: new Date().toISOString()
      });
    } catch (error) { console.error('Call initiation error:', error); }
  });

  socket.on('accept-call', ({ chatId, calleeId }) => {
    console.log(`✅ Call accepted by: ${userName} (${calleeId})`);
    const calleeInfo = userInfo.get(calleeId) || { name: userName, photo: socket.userPhoto };
    socket.to(chatId).emit('call-accepted', {
      calleeId, calleeName: calleeInfo.name, calleePhoto: calleeInfo.photo,
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

  // ==================== WEBRTC SIGNALING ====================
  socket.on('webrtc-offer',         ({ chatId, offer })     => socket.to(chatId).emit('webrtc-offer',         { from: userId, offer }));
  socket.on('webrtc-answer',        ({ chatId, answer })    => socket.to(chatId).emit('webrtc-answer',        { from: userId, answer }));
  socket.on('webrtc-ice-candidate', ({ chatId, candidate }) => socket.to(chatId).emit('webrtc-ice-candidate', { from: userId, candidate }));

  // ==================== DISCONNECT ====================
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${userName} (${socket.id})`);
    const user = userPresence.get(userId);
    if (user) { user.status = 'OFFLINE'; user.lastSeen = new Date(); }
    io.emit('user-offline', { userId, userName, lastSeen: user?.lastSeen?.toISOString() });
    if (socket.chatId && chatUsers.has(socket.chatId)) {
      chatUsers.get(socket.chatId).delete(socket.id);
      if (chatUsers.get(socket.chatId).size === 0) chatUsers.delete(socket.chatId);
      socket.to(socket.chatId).emit('user-left', { userId, userName });
    }
  });
});

// =============================================
// PRESENCE HELPER FUNCTIONS
// =============================================
function isUserOnline(userId)  { return userPresence.get(userId)?.status === 'ONLINE'; }
function getUserLastSeen(userId) { return userPresence.get(userId)?.lastSeen || null; }
function getUserInfo(userId)   { return userInfo.get(userId) || null; }
global.isUserOnline   = isUserOnline;
global.getUserLastSeen = getUserLastSeen;
global.getUserInfo    = getUserInfo;

// =============================================
// IMPORT JOBS & MIDDLEWARE
// =============================================
const { startExpiryJob }           = require('./jobs/sessionExpiryJob');
const { startMovieSessionExpiryJob } = require('./jobs/movieSessionExpiryJob');
const { runStartupCleanup, scheduleDailyCleanup } = require('./utils/autoModerationCleanup');
const { startPayoutCronJobs } = require('./cronJobs/payoutCron');

// =============================================
// DATABASE CONNECTION
// =============================================
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');

    startExpiryJob(io);
    startMovieSessionExpiryJob();
    startPayoutCronJobs();
    await runStartupCleanup();
    scheduleDailyCleanup();
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  }
};

connectDB();

// =============================================
// IMPORT MIDDLEWARE & ROUTES
// =============================================
const { authenticate, adminOnly } = require('./middleware/auth');
const { enforceLegalAcceptance }  = require('./middleware/enforceLegalAcceptance');
const moderationRoutes            = require('./routes/moderation');

const gamingRoutes           = require('./routes/gamingRoutes');
const { initSessionSocket }  = require('./sockets/sessionSocket');
initSessionSocket(io);

const authRoutes             = require('./routes/auth');
const userRoutes             = require('./routes/users');
const legalRoutes            = require('./routes/legal');
const eventRoutes            = require('./routes/events');
const companionRoutes        = require('./routes/companions');
const bookingRoutes          = require('./routes/bookings');
const messageRoutes          = require('./routes/messages');
const postRoutes             = require('./routes/posts');
const spotlightRoutes        = require('./routes/spotlight.route');
const safetyReportRoutes     = require('./routes/safetyReports');
const profileRoutes          = require('./routes/profile');
const activityRoutes         = require('./routes/activityRoutes');
const reviewRoutes           = require('./routes/reviews');
const paymentRoutes          = require('./routes/payment');
const foodRoutes             = require('./routes/foodRoutes');
const settingsRoutes         = require('./routes/settings');
const profileAssistantRoutes = require('./routes/profileAssistant');
const movieSessionRoutes     = require('./routes/movieSessionRoutes');
const passwordResetRoutes    = require('./routes/passwordReset');
const fcmTokenRoutes         = require('./routes/fcmToken');

// =============================================
// PUBLIC ROUTES
// =============================================
app.use('/api/auth',  authRoutes);
app.use('/api/auth',  passwordResetRoutes);
app.use('/api/legal', legalRoutes);

// =============================================
// PROTECTED ROUTES
// =============================================
app.use('/api/users',             authenticate, enforceLegalAcceptance, userRoutes);
app.use('/api/events',            authenticate, enforceLegalAcceptance, eventRoutes);
app.use('/api/companions',        authenticate, enforceLegalAcceptance, companionRoutes);
app.use('/api/bookings',          authenticate, enforceLegalAcceptance, bookingRoutes);
app.use('/api/messages',          authenticate, enforceLegalAcceptance, messageRoutes);
app.use('/api/posts',             authenticate, enforceLegalAcceptance, postRoutes);
app.use('/api/spotlight',         authenticate, enforceLegalAcceptance, spotlightRoutes);
app.use('/api/safety',            authenticate, enforceLegalAcceptance, safetyReportRoutes);
app.use('/api/profile',           authenticate, enforceLegalAcceptance, profileRoutes);
app.use('/api/reviews',           authenticate, enforceLegalAcceptance, reviewRoutes);
app.use('/api/payment',           authenticate, enforceLegalAcceptance, paymentRoutes);
app.use('/api/random-booking',    authenticate, enforceLegalAcceptance, require('./routes/randomBooking'));
app.use('/api/verification',      authenticate, enforceLegalAcceptance, require('./routes/verification'));
app.use('/api/settings',          authenticate, enforceLegalAcceptance, settingsRoutes);
app.use('/api/profile-assistant', profileAssistantRoutes);
app.use('/api/admin',             authenticate, require('./routes/admin'));
app.use('/api/moderation',        authenticate, adminOnly, moderationRoutes);
app.use('/api/agora',             authenticate, enforceLegalAcceptance, require('./routes/agora'));
app.use('/api/voice-call',        authenticate, enforceLegalAcceptance, require('./routes/voice-call'));
app.use('/api/activity',          authenticate, enforceLegalAcceptance, activityRoutes);
app.use('/api/session',           authenticate, enforceLegalAcceptance, gamingRoutes);
app.use('/api/food',              authenticate, enforceLegalAcceptance, foodRoutes);
app.use('/api',                   authenticate, enforceLegalAcceptance, movieSessionRoutes);
app.use('/api/auth',              authenticate, fcmTokenRoutes);
app.use('/api/events',            authenticate, require('./routes/featureClicks'));

require('./cronJobs');

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
  res.json({
    status:   'OK',
    message:  'Humrah API is running',
    socketConnections:      io.engine.clientsCount,
    activeChats:            chatUsers.size,
    onlineUsers:            Array.from(userPresence.values()).filter(u => u.status === 'ONLINE').length,
    gamingNamespaceClients: io.of('/gaming').sockets.size
  });
});

// =============================================
// GLOBAL ERROR HANDLER
// =============================================
app.use((err, req, res, next) => {
  // CORS errors — return 403, not 500
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    // Never leak stack traces in production
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Humrah Server running on port ${PORT}`);
  console.log(`✅ Socket.IO enabled`);
  console.log(`✅ Legal compliance enforcement active`);
  console.log(`✅ OTP system: MongoDB-backed, bcrypt+pepper, multi-instance safe`);
  console.log(`✅ FCM Token route: POST /api/auth/fcm-token`);
  console.log(`✅ Password reset: POST /api/auth/forgot-password + /api/auth/reset-password`);
  console.log(`✅ Trust proxy enabled (Render reverse proxy)`);
  console.log(`✅ Body size limit: 100kb JSON`);
  console.log(`✅ CORS: origin whitelist active`);
});

// =============================================
// GRACEFUL SHUTDOWN
// =============================================
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} signal received: closing HTTP server`);
  server.close(async () => {
    try {
      await mongoose.connection.close();
      console.log('MongoDB connection closed');
      process.exit(0);
    } catch (err) {
      console.error('Error closing MongoDB connection:', err);
      process.exit(1);
    }
  });
  setTimeout(() => { process.exit(1); }, 10000);
};

process.on('SIGTERM',            () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',             () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  (err)    => { console.error('Uncaught Exception:', err);    gracefulShutdown('UNCAUGHT_EXCEPTION'); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); gracefulShutdown('UNHANDLED_REJECTION'); });

module.exports = { app, server, io };
