// server.js - UPDATED WITH LEGAL ACCEPTANCE ENFORCEMENT + PRODUCTION SECURITY HARDENING + LIVE LOCATION MATCHMAKING
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

server.keepAliveTimeout = 120000;
server.headersTimeout   = 125000;

const ALLOWED_ORIGINS = [
  'https://humrah.in',
  'https://www.humrah.in',
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (origin.endsWith('.vercel.app') || origin === 'https://admin.humrah.in') return callback(null, true);
    if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
};

const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      if (origin.endsWith('.vercel.app') || origin === 'https://admin.humrah.in') return callback(null, true);
      if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost')) {
        return callback(null, true);
      }
      return callback(new Error(`Socket CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST"],
  },
  transports: ['websocket'],
  pingTimeout: 90000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  allowUpgrades: true,
});

app.set('trust proxy', 1);

app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc:      ["'self'", "data:", "https://res.cloudinary.com", "https://*.tile.openstreetmap.org", "https://*.google.com"],
      connectSrc:  ["'self'", "https://api.humrah.in"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(cors(corsOptions));
app.use(mongoSanitize());
app.use(hpp());
app.use(globalLimiter);

app.use('/api/users/upload-profile-photo-base64',      express.json({ limit: '5mb' }));
app.use('/api/users/submit-verification-photo-base64', express.json({ limit: '5mb' }));
app.use('/api/posts',                                  express.json({ limit: '5mb' }));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

app.set('io', io);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.get('/live/:sessionId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'humrah-live-safety.html'));
});

app.get('/humrah-live-safety.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'humrah-live-safety.html'));
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

    if (!token) return next(new Error('Authentication error: No token provided'));

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) return next(new Error('Authentication error: Server misconfiguration'));

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
        }
      })
      .catch(err => { console.error('Error fetching user info:', err); socket.userName = 'User'; });

    next();
  } catch (err) {
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

  socket.join(`user:${userId}`);

  userPresence.set(userId, {
    socketId: socket.id,
    status:   'ONLINE',
    lastSeen: new Date(),
    name:     userName,
    photo:    socket.userPhoto
  });

  io.emit('user-online', { userId, userName });

  socket.on('join-chat', async (data) => {
    try {
      const { chatId } = data;
      socket.join(chatId);
      socket.chatId = chatId;
      if (!chatUsers.has(chatId)) chatUsers.set(chatId, new Set());
      chatUsers.get(chatId).add(socket.id);

      socket.to(chatId).emit('user-online', { userId, userName });

      const RandomBookingChat = mongoose.model('RandomBookingChat');
      const chat = await RandomBookingChat.findById(chatId);
      if (chat) {
        const otherParticipant = chat.participants.find(p => p.userId.toString() !== userId);
        if (otherParticipant) {
          const otherId = otherParticipant.userId.toString();
          if (isUserOnline(otherId)) {
            socket.emit('user-online', { userId: otherId });
          } else {
            const lastSeen = getUserLastSeen(otherId);
            socket.emit('user-offline', { userId: otherId, lastSeen: lastSeen?.toISOString() || null });
          }
        }

        const Message = mongoose.model('Message');
        const otherUserId = chat.participants.find(p => p.userId.toString() !== userId)?.userId;
        const pending = await Message.find({ chatId, senderId: otherUserId, deliveryStatus: 'SENT' })
          .populate('senderId', 'firstName lastName profilePhoto');

        for (const msg of pending) {
          socket.emit('new-message', {
            _id: msg._id.toString(), chatId: msg.chatId.toString(),
            senderId: msg.senderId._id.toString(),
            senderIdRaw: { _id: msg.senderId._id.toString(), firstName: msg.senderId.firstName, lastName: msg.senderId.lastName, profilePhoto: msg.senderId.profilePhoto },
            content: msg.content, messageType: msg.messageType,
            timestamp: msg.timestamp.toISOString(), deliveryStatus: 'SENT'
          });
          msg.deliveryStatus = 'DELIVERED';
          msg.deliveredAt    = new Date();
          await msg.save();
          io.to(chatId).emit('message-delivered', { messageId: msg._id.toString(), deliveredTo: userId, deliveredAt: msg.deliveredAt.toISOString() });
        }
      }
    } catch (error) { console.error('Join chat error:', error); }
  });

  socket.on('leave-chat', (chatId) => {
    socket.leave(chatId);
    if (chatUsers.has(chatId)) {
      chatUsers.get(chatId).delete(socket.id);
      if (chatUsers.get(chatId).size === 0) chatUsers.delete(chatId);
    }
    socket.to(chatId).emit('user-left', { userId, userName });
  });

  socket.on('message-delivered', async (data) => {
    try {
      const { messageId, chatId } = data;
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      if (message && message.deliveryStatus === 'SENT') {
        message.deliveryStatus = 'DELIVERED';
        message.deliveredAt    = new Date();
        await message.save();
        socket.to(chatId).emit('message-delivered', { messageId, deliveredTo: userId, deliveredAt: message.deliveredAt.toISOString() });
      }
    } catch (error) { console.error('Message delivered error:', error); }
  });

  socket.on('message-read', async (data) => {
    try {
      const { messageId, chatId } = data;
      const Message = mongoose.model('Message');
      const message = await Message.findById(messageId);
      if (message && message.deliveryStatus !== 'READ') {
        message.deliveryStatus = 'READ';
        message.readAt         = new Date();
        await message.save();
        socket.to(chatId).emit('message-read', { messageId, readBy: userId, readAt: message.readAt.toISOString() });
      }
    } catch (error) { console.error('Message read error:', error); }
  });

  const typingTimeouts = new Map();

  socket.on('typing-start', ({ chatId }) => {
    if (!chatId) return;
    socket.to(chatId).emit('user-typing', { userId, userName, isTyping: true });
    const key = `${socket.id}:${chatId}`;
    if (typingTimeouts.has(key)) clearTimeout(typingTimeouts.get(key));
    typingTimeouts.set(key, setTimeout(() => {
      socket.to(chatId).emit('user-typing', { userId, userName, isTyping: false });
      typingTimeouts.delete(key);
    }, 6000));
  });

  socket.on('typing-stop', ({ chatId }) => {
    if (!chatId) return;
    socket.to(chatId).emit('user-typing', { userId, userName, isTyping: false });
    const key = `${socket.id}:${chatId}`;
    if (typingTimeouts.has(key)) { clearTimeout(typingTimeouts.get(key)); typingTimeouts.delete(key); }
  });

  socket.on('initiate-call', async (data) => {
    try {
      const { chatId, callerId, calleeId, isAudioOnly } = data;
      const callerInfo = userInfo.get(callerId) || { name: userName, photo: socket.userPhoto };
      socket.to(chatId).emit('incoming-call', { chatId, callerId, callerName: callerInfo.name, callerPhoto: callerInfo.photo, isAudioOnly, timestamp: new Date().toISOString() });
    } catch (error) { console.error('Call initiation error:', error); }
  });

  socket.on('accept-call', ({ chatId, calleeId }) => {
    const calleeInfo = userInfo.get(calleeId) || { name: userName, photo: socket.userPhoto };
    socket.to(chatId).emit('call-accepted', { calleeId, calleeName: calleeInfo.name, calleePhoto: calleeInfo.photo, timestamp: new Date().toISOString() });
  });

  // BUG 5 FIX: Handle accept-voice-call socket emit from Android.
  // Android sends BOTH this socket emit AND POST /api/voice-call/accept/:callId (HTTP).
  // The HTTP route does the real work (generates Agora token, updates DB).
  // This handler exists so the emit is acknowledged server-side and is visible in
  // server logs — it emits nothing back because the HTTP route already does that
  // via voice-call-accepted on the caller's user room.
  socket.on('accept-voice-call', ({ callId }) => {
    if (!callId) return;
    console.log(`📡 Socket: accept-voice-call received for callId=${callId} from userId=${userId} (HTTP flow handles the real acceptance)`);
    // No additional emit needed — POST /api/voice-call/accept/:callId already emits
    // voice-call-accepted to the caller via io.to('user:callerId').
  });

  socket.on('reject-call', ({ chatId, calleeId }) => {
    socket.to(chatId).emit('call-rejected', { calleeId, timestamp: new Date().toISOString() });
  });

  socket.on('end-call', ({ chatId }) => {
    socket.to(chatId).emit('call-ended', { endedBy: userId, timestamp: new Date().toISOString() });
  });

  socket.on('webrtc-offer',         ({ chatId, offer })     => socket.to(chatId).emit('webrtc-offer',         { from: userId, offer }));
  socket.on('webrtc-answer',        ({ chatId, answer })    => socket.to(chatId).emit('webrtc-answer',        { from: userId, answer }));
  socket.on('webrtc-ice-candidate', ({ chatId, candidate }) => socket.to(chatId).emit('webrtc-ice-candidate', { from: userId, candidate }));

  // ── Movie Session Chat rooms ──────────────────────────────────────────────
  // Room name: "movie-chat-{chatId}"
  // Events: join-movie-chat, leave-movie-chat, movie-send-message
  // Emitted back: movie-new-message, movie-user-joined, movie-user-left, movie-typing

  socket.on('join-movie-chat', async ({ chatId }) => {
    if (!chatId) return;
    socket.join(`movie-chat-${chatId}`);
    socket.movieChatId = chatId;

    // Notify others in the room
    socket.to(`movie-chat-${chatId}`).emit('movie-user-joined', {
      userId,
      userName,
      userPhoto: socket.userPhoto,
    });
  });

  socket.on('leave-movie-chat', ({ chatId }) => {
    if (!chatId) return;
    socket.leave(`movie-chat-${chatId}`);
    if (socket.movieChatId === chatId) socket.movieChatId = null;
    socket.to(`movie-chat-${chatId}`).emit('movie-user-left', { userId, userName });
  });

  socket.on('movie-typing-start', ({ chatId }) => {
    if (!chatId) return;
    socket.to(`movie-chat-${chatId}`).emit('movie-typing', { userId, userName, isTyping: true });
  });

  socket.on('movie-typing-stop', ({ chatId }) => {
    if (!chatId) return;
    socket.to(`movie-chat-${chatId}`).emit('movie-typing', { userId, userName, isTyping: false });
  });

  socket.on('disconnect', () => {
    for (const [key, timeout] of typingTimeouts.entries()) {
      if (key.startsWith(socket.id)) {
        clearTimeout(timeout);
        typingTimeouts.delete(key);
        const chatId = key.split(':')[1];
        if (chatId) socket.to(chatId).emit('user-typing', { userId, isTyping: false });
      }
    }
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

function isUserOnline(userId)   { return userPresence.get(userId)?.status === 'ONLINE'; }
function getUserLastSeen(userId) { return userPresence.get(userId)?.lastSeen || null; }
function getUserInfo(userId)     { return userInfo.get(userId) || null; }
global.isUserOnline    = isUserOnline;
global.getUserLastSeen = getUserLastSeen;
global.getUserInfo     = getUserInfo;

// =============================================
// JOBS & CLEANUP
// =============================================
const { startExpiryJob }             = require('./jobs/sessionExpiryJob');
const { startMovieSessionExpiryJob } = require('./jobs/movieSessionExpiryJob');
const { startMovieDailySessionJob }  = require('./jobs/movieDailySessionJob');
const { runStartupCleanup, scheduleDailyCleanup } = require('./utils/autoModerationCleanup');
const { startPayoutCronJobs } = require('./cronJobs/payoutCron');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
    startExpiryJob(io);
    startMovieSessionExpiryJob();
    startMovieDailySessionJob();  // pre-seeds tomorrow's system sessions at 7 PM IST
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
// ROUTES
// =============================================
const { authenticate, adminOnly } = require('./middleware/auth');
const { enforceLegalAcceptance }  = require('./middleware/enforceLegalAcceptance');
const moderationRoutes            = require('./routes/moderation');
const gamingRoutes                = require('./routes/gamingRoutes');
const { initSessionSocket }       = require('./sockets/sessionSocket');
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
const matchingMoodRoutes     = require('./routes/matchingMood');
const moodRequestRoutes      = require('./routes/moodRequest');
const safetyToolsRoutes      = require('./routes/safetyTools');
const safetyTicketRoutes     = require('./routes/safetyTickets'); // ✅ Phase 2 Safety Tickets
// ✅ NEW: Lightweight live location for matchmaking (separate from safety live-location)
const liveLocationMatchmakingRoutes = require('./routes/liveLocationMatchmaking');

// Health check must stay public and before broad authenticated /api routes.
// ── Public routes ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:   'OK',
    message:  'Humrah API is running',
    socketConnections:      io.engine.clientsCount,
    activeChats:            chatUsers.size,
    onlineUsers:            Array.from(userPresence.values()).filter(u => u.status === 'ONLINE').length,
  });
});

app.use('/api/auth',  authRoutes);
app.use('/api/auth',  passwordResetRoutes);
app.use('/api/admin-dashboard-auth', require('./routes/adminDashboardAuth'));
app.use('/api/legal', legalRoutes);

const { liveLocationPollLimiter } = require('./routes/liveLocationRoutes');
app.get('/api/live-location/:sessionId', liveLocationPollLimiter, require('./controllers/liveLocationController').get);

// ── Protected routes ───────────────────────────────────────────────────────────
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
app.use('/api/profile-assistant', authenticate, profileAssistantRoutes);
app.use('/api/admin',             authenticate, require('./routes/admin'));
app.use('/api/admin-dashboard',   authenticate, require('./routes/adminDashboard'));
app.use('/api/admin-analytics',   authenticate, require('./routes/adminAnalytics'));
app.use('/api/moderation',        authenticate, adminOnly, moderationRoutes);
app.use('/api/agora',             authenticate, enforceLegalAcceptance, require('./routes/agora'));
app.use('/api/voice-call',        authenticate, enforceLegalAcceptance, require('./routes/voice-call'));
app.use('/api/activity',          authenticate, enforceLegalAcceptance, activityRoutes);
app.use('/api/session',           authenticate, enforceLegalAcceptance, gamingRoutes);
app.use('/api/food',              authenticate, enforceLegalAcceptance, foodRoutes);
app.use('/api',                   authenticate, enforceLegalAcceptance, movieSessionRoutes);
app.use('/api/auth',              authenticate, fcmTokenRoutes);
app.use('/api/events',            authenticate, require('./routes/featureClicks'));
app.use('/api/matching-mood',     authenticate, enforceLegalAcceptance, matchingMoodRoutes);
app.use('/api/mood-request',      authenticate, enforceLegalAcceptance, moodRequestRoutes);
app.use('/api/safety-tools',      authenticate, enforceLegalAcceptance, safetyToolsRoutes);
app.use('/api/safety-tickets',    authenticate, enforceLegalAcceptance, safetyTicketRoutes); // ✅ Phase 2
app.use('/api/live-location',     authenticate, enforceLegalAcceptance, require('./routes/liveLocationRoutes'));
app.use('/api',                   authenticate, enforceLegalAcceptance, require('./routes/moderation_route'));

// ✅ NEW: Live location for matchmaking — POST /api/users/matchmaking-location
//         Separate from safety live-location. Updates liveLocation on User doc.
app.use('/api/users/matchmaking-location', authenticate, enforceLegalAcceptance, liveLocationMatchmakingRoutes);

require('./cronJobs');
require('./jobs/moodExpiry');

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ── Start server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`🚀 Humrah Server running on ${HOST}:${PORT}`);
  console.log(`✅ Socket.IO enabled`);
  console.log(`✅ Legal compliance enforcement active`);
  console.log(`✅ Live Location Matchmaking: POST /api/users/matchmaking-location`);
  console.log(`✅ Live Location Status:      GET  /api/users/matchmaking-location/status`);
});

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
