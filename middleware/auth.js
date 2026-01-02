// middleware/auth.js - Enhanced Authentication & Authorization Middleware
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

// =============================================
// AUTHENTICATION MIDDLEWARE
// =============================================
/**
 * Verify JWT token and attach user to request
 */
exports.authenticate = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.replace('Bearer ', '')
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token provided'
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'fallback_secret_change_in_production'
    );

    // Fetch user from database (CRITICAL: get fresh data including role)
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if account is locked
    if (user.isLocked()) {
      return res.status(403).json({
        success: false,
        message: 'Account is temporarily locked. Please try again later.'
      });
    }

    // Check if account is active
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status.toLowerCase()}`,
        status: user.status
      });
    }

    // Check if suspended
    if (user.suspensionInfo?.isSuspended) {
      const until = user.suspensionInfo.suspendedUntil;
      return res.status(403).json({
        success: false,
        message: 'Account is suspended',
        suspensionInfo: {
          reason: user.suspensionInfo.suspensionReason,
          until: until ? until.toISOString() : 'indefinite',
          restrictions: user.suspensionInfo.restrictions
        }
      });
    }

    // Check if banned
    if (user.banInfo?.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'Account is banned',
        banInfo: {
          reason: user.banInfo.banReason,
          permanent: user.banInfo.isPermanent
        }
      });
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    // Attach user to request
    req.user = user;
    req.userId = user._id;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired, please login again'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }

    console.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// =============================================
// ROLE-BASED AUTHORIZATION MIDDLEWARE
// =============================================
/**
 * Check if user has one of the required roles
 * Usage: authorize(['SAFETY_ADMIN', 'SUPER_ADMIN'])
 */
exports.authorize = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      // Ensure user is authenticated
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // Check if user's role is in allowed roles
      if (!allowedRoles.includes(req.user.role)) {
        // Log unauthorized access attempt
        await AuditLog.logAction({
          actorId: req.user._id,
          actorRole: req.user.role,
          actorEmail: req.user.email,
          action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
          targetType: 'SYSTEM',
          details: {
            requestedPath: req.path,
            requestedMethod: req.method,
            requiredRoles: allowedRoles,
            userRole: req.user.role
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          requestMethod: req.method,
          requestPath: req.path,
          isSuccessful: false
        });

        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions',
          required: allowedRoles,
          current: req.user.role
        });
      }

      next();
    } catch (error) {
      console.error('Authorization error:', error);
      return res.status(500).json({
        success: false,
        message: 'Authorization check failed'
      });
    }
  };
};

// =============================================
// PERMISSION-BASED AUTHORIZATION
// =============================================
/**
 * Check if user has specific permission
 * Usage: requirePermission('canBanUsers')
 */
exports.requirePermission = (permission) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // Super admin has all permissions
      if (req.user.role === 'SUPER_ADMIN') {
        return next();
      }

      // Check specific permission
      if (!req.user.hasPermission(permission)) {
        await AuditLog.logAction({
          actorId: req.user._id,
          actorRole: req.user.role,
          actorEmail: req.user.email,
          action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
          targetType: 'SYSTEM',
          details: {
            requestedPath: req.path,
            requestedMethod: req.method,
            requiredPermission: permission,
            userPermissions: req.user.adminPermissions
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          requestMethod: req.method,
          requestPath: req.path,
          isSuccessful: false
        });

        return res.status(403).json({
          success: false,
          message: `Missing permission: ${permission}`
        });
      }

      next();
    } catch (error) {
      console.error('Permission check error:', error);
      return res.status(500).json({
        success: false,
        message: 'Permission check failed'
      });
    }
  };
};

// =============================================
// ACTION-BASED AUTHORIZATION
// =============================================
/**
 * Check if user can perform specific action
 * (checks for suspensions/restrictions)
 * Usage: canPerformAction('chat')
 */
exports.canPerformAction = (action) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      if (!req.user.canPerformAction(action)) {
        return res.status(403).json({
          success: false,
          message: `You are restricted from ${action}`,
          restrictions: req.user.suspensionInfo?.restrictions || []
        });
      }

      next();
    } catch (error) {
      console.error('Action check error:', error);
      return res.status(500).json({
        success: false,
        message: 'Action check failed'
      });
    }
  };
};

// =============================================
// ADMIN-ONLY MIDDLEWARE (Shortcut)
// =============================================
/**
 * Ensure user is SAFETY_ADMIN or SUPER_ADMIN
 */
exports.adminOnly = exports.authorize('SAFETY_ADMIN', 'SUPER_ADMIN');

/**
 * Ensure user is SUPER_ADMIN only
 */
exports.superAdminOnly = exports.authorize('SUPER_ADMIN');

/**
 * Ensure user is regular USER only
 */
exports.userOnly = exports.authorize('USER');

// =============================================
// OWNERSHIP VERIFICATION
// =============================================
/**
 * Check if user owns the resource (e.g., their own profile)
 * Usage: verifyOwnership('userId')
 */
exports.verifyOwnership = (paramName = 'userId') => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const resourceOwnerId = req.params[paramName] || req.body[paramName];

      // Admins can access any resource
      if (req.user.role !== 'USER') {
        return next();
      }

      // Regular users can only access their own resources
      if (req.user._id.toString() !== resourceOwnerId) {
        return res.status(403).json({
          success: false,
          message: 'You can only access your own resources'
        });
      }

      next();
    } catch (error) {
      console.error('Ownership verification error:', error);
      return res.status(500).json({
        success: false,
        message: 'Ownership verification failed'
      });
    }
  };
};

// =============================================
// RATE LIMITING MIDDLEWARE
// =============================================
const rateLimitMap = new Map();

/**
 * Simple in-memory rate limiter
 * Usage: rateLimit(10, 60000) // 10 requests per minute
 */
exports.rateLimit = (maxRequests = 10, windowMs = 60000) => {
  return (req, res, next) => {
    try {
      const key = req.user ? req.user._id.toString() : req.ip;
      const now = Date.now();
      
      if (!rateLimitMap.has(key)) {
        rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
        return next();
      }
      
      const userData = rateLimitMap.get(key);
      
      if (now > userData.resetTime) {
        rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
        return next();
      }
      
      if (userData.count >= maxRequests) {
        return res.status(429).json({
          success: false,
          message: 'Too many requests, please try again later',
          retryAfter: Math.ceil((userData.resetTime - now) / 1000)
        });
      }
      
      userData.count++;
      return next();
    } catch (error) {
      console.error('Rate limit error:', error);
      return next(); // Don't block on error
    }
  };
};

// Clean up rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 60000); // Clean every minute

// =============================================
// AUDIT LOGGING MIDDLEWARE
// =============================================
/**
 * Automatically log admin actions
 * Usage: auditLog('VIEW_REPORT')
 */
exports.auditLog = (action, targetType = 'SYSTEM') => {
  return async (req, res, next) => {
    // Store start time
    const startTime = Date.now();
    
    // Capture original send function
    const originalSend = res.send;
    
    // Override send function to log after response
    res.send = function (data) {
      // Calculate response time
      const responseTime = Date.now() - startTime;
      
      // Log the action (async, don't wait)
      if (req.user && req.user.isAdmin) {
        AuditLog.logAction({
          actorId: req.user._id,
          actorRole: req.user.role,
          actorEmail: req.user.email,
          action,
          targetType,
          targetId: req.params.id || req.params.userId || req.params.reportId,
          details: {
            params: req.params,
            query: req.query,
            body: sanitizeBody(req.body)
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          requestMethod: req.method,
          requestPath: req.path,
          statusCode: res.statusCode,
          responseTime,
          isSuccessful: res.statusCode < 400
        }).catch(err => console.error('Audit log error:', err));
      }
      
      // Call original send
      return originalSend.call(this, data);
    };
    
    next();
  };
};

/**
 * Sanitize request body for logging (remove sensitive data)
 */
function sanitizeBody(body) {
  if (!body) return {};
  
  const sanitized = { ...body };
  const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'creditCard'];
  
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });
  
  return sanitized;
}

// =============================================
// EXPORTS SUMMARY
// =============================================
module.exports = {
  // Core authentication
  authenticate: exports.authenticate,
  
  // Role-based authorization
  authorize: exports.authorize,
  adminOnly: exports.adminOnly,
  superAdminOnly: exports.superAdminOnly,
  userOnly: exports.userOnly,
  
  // Permission-based authorization
  requirePermission: exports.requirePermission,
  
  // Action-based authorization
  canPerformAction: exports.canPerformAction,
  
  // Ownership verification
  verifyOwnership: exports.verifyOwnership,
  
  // Rate limiting
  rateLimit: exports.rateLimit,
  
  // Audit logging
  auditLog: exports.auditLog
};
