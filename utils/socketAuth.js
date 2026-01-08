// utils/socketAuth.js - JWT AUTHENTICATION FOR SOCKETS
const jwt = require('jsonwebtoken');

/**
 * Socket.IO Authentication Middleware
 * Verifies JWT token and attaches user info to socket
 * 
 * Usage in server.js:
 * const { socketAuthMiddleware } = require('./utils/socketAuth');
 * io.use(socketAuthMiddleware);
 */

/**
 * Middleware function for Socket.IO authentication
 */
const socketAuthMiddleware = (socket, next) => {
  try {
    // ✅ Get token from handshake auth
    const token = socket.handshake.auth.token;
    
    if (!token) {
      console.log('❌ Socket auth failed: No token provided');
      return next(new Error('Authentication error: No token provided'));
    }
    
    // ✅ Verify JWT token
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_production';
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // ✅ Attach user info to socket
    socket.userId = decoded.userId;
    socket.userRole = decoded.role || 'USER';
    socket.userName = `${decoded.firstName} ${decoded.lastName || ''}`.trim();
    socket.userEmail = decoded.email;
    
    console.log(`✅ Socket authenticated: ${socket.userName} (${socket.userId})`);
    
    next();
    
  } catch (err) {
    console.log('❌ Socket auth failed:', err.message);
    
    if (err.name === 'TokenExpiredError') {
      return next(new Error('Authentication error: Token expired'));
    }
    
    if (err.name === 'JsonWebTokenError') {
      return next(new Error('Authentication error: Invalid token'));
    }
    
    return next(new Error('Authentication error: ' + err.message));
  }
};

/**
 * Verify token manually (for special cases)
 */
const verifySocketToken = (token) => {
  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_production';
    const decoded = jwt.verify(token, JWT_SECRET);
    return {
      success: true,
      userId: decoded.userId,
      role: decoded.role,
      userName: `${decoded.firstName} ${decoded.lastName || ''}`.trim()
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
};

/**
 * Check if user has admin role
 */
const isAdmin = (socket) => {
  return socket.userRole === 'SAFETY_ADMIN' || socket.userRole === 'SUPER_ADMIN';
};

/**
 * Check if user has specific permission
 */
const hasPermission = (socket, requiredRole) => {
  const roleHierarchy = {
    'USER': 1,
    'SAFETY_ADMIN': 2,
    'SUPER_ADMIN': 3
  };
  
  const userLevel = roleHierarchy[socket.userRole] || 0;
  const requiredLevel = roleHierarchy[requiredRole] || 0;
  
  return userLevel >= requiredLevel;
};

/**
 * Authenticate and authorize socket for chat access
 */
const authorizeChat = async (socket, chatId, ChatModel) => {
  try {
    const chat = await ChatModel.findById(chatId);
    
    if (!chat) {
      return {
        authorized: false,
        reason: 'Chat not found'
      };
    }
    
    // Check if user is participant
    const isParticipant = chat.isParticipant(socket.userId);
    
    // Admins can access any chat
    const isAdminUser = isAdmin(socket);
    
    if (!isParticipant && !isAdminUser) {
      return {
        authorized: false,
        reason: 'Not a participant in this chat'
      };
    }
    
    // Check if chat is expired (for RandomBookingChat)
    if (chat.isExpired && chat.isExpired()) {
      return {
        authorized: false,
        reason: 'Chat has expired'
      };
    }
    
    // Check if chat is deleted
    if (chat.isDeleted) {
      return {
        authorized: false,
        reason: 'Chat has been deleted'
      };
    }
    
    return {
      authorized: true,
      chat,
      isAdmin: isAdminUser
    };
    
  } catch (error) {
    console.error('Authorization error:', error);
    return {
      authorized: false,
      reason: 'Authorization failed: ' + error.message
    };
  }
};

/**
 * Rate limiting for socket events
 */
class SocketRateLimiter {
  constructor() {
    this.limits = new Map();
  }
  
  /**
   * Check if user exceeded rate limit
   * @param {string} userId - User ID
   * @param {string} eventType - Type of event (e.g., 'message', 'typing')
   * @param {number} maxPerMinute - Max events per minute
   * @returns {boolean} - true if allowed, false if rate limited
   */
  checkLimit(userId, eventType, maxPerMinute = 60) {
    const key = `${userId}:${eventType}`;
    const now = Date.now();
    const oneMinute = 60 * 1000;
    
    if (!this.limits.has(key)) {
      this.limits.set(key, []);
    }
    
    const events = this.limits.get(key);
    
    // Remove events older than 1 minute
    const recentEvents = events.filter(time => now - time < oneMinute);
    this.limits.set(key, recentEvents);
    
    // Check if limit exceeded
    if (recentEvents.length >= maxPerMinute) {
      return false;
    }
    
    // Add current event
    recentEvents.push(now);
    this.limits.set(key, recentEvents);
    
    return true;
  }
  
  /**
   * Clear rate limit for user
   */
  clearLimit(userId, eventType) {
    const key = `${userId}:${eventType}`;
    this.limits.delete(key);
  }
  
  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    const oneMinute = 60 * 1000;
    
    for (const [key, events] of this.limits.entries()) {
      const recentEvents = events.filter(time => now - time < oneMinute);
      if (recentEvents.length === 0) {
        this.limits.delete(key);
      } else {
        this.limits.set(key, recentEvents);
      }
    }
  }
}

// Create global rate limiter
const rateLimiter = new SocketRateLimiter();

// Cleanup every 5 minutes
setInterval(() => {
  rateLimiter.cleanup();
}, 5 * 60 * 1000);

/**
 * Rate limit middleware wrapper
 */
const rateLimitEvent = (eventType, maxPerMinute = 60) => {
  return (socket, next) => {
    if (!rateLimiter.checkLimit(socket.userId, eventType, maxPerMinute)) {
      console.log(`⚠️ Rate limit exceeded: ${socket.userName} (${eventType})`);
      return next(new Error('Rate limit exceeded. Please slow down.'));
    }
    next();
  };
};

/**
 * Log socket event for audit
 */
const logSocketEvent = (socket, eventType, data = {}) => {
  console.log(`📡 Socket Event: ${eventType}`, {
    userId: socket.userId,
    userName: socket.userName,
    socketId: socket.id,
    timestamp: new Date().toISOString(),
    data
  });
};

module.exports = {
  socketAuthMiddleware,
  verifySocketToken,
  isAdmin,
  hasPermission,
  authorizeChat,
  rateLimiter,
  rateLimitEvent,
  logSocketEvent
};
