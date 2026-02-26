// middleware/auth.js - Authentication & Authorization Middleware ONLY
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

// =============================================
// AUTHENTICATION MIDDLEWARE
// =============================================
/**
 * Verify JWT token and attach user to request
 */
const authenticate = async (req, res, next) => {
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

    // Check if account is locked (if method exists)
    if (user.isLocked && user.isLocked()) {
      return res.status(403).json({
        success: false,
        message: 'Account is temporarily locked. Please try again later.'
      });
    }

    // Check if account is active
    if (user.status && user.status !== 'ACTIVE') {
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
// BACKWARD COMPATIBILITY
// Export as both 'auth' and 'authenticate'
// =============================================
const auth = authenticate;

// =============================================
// ROLE-BASED AUTHORIZATION MIDDLEWARE
// =============================================
/**
 * Check if user has one of the required roles
 * Usage: authorize(['SAFETY_ADMIN', 'SUPER_ADMIN'])
 */
const authorize = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      // Ensure user is authenticated
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // Get user role (handle both old and new User models)
      const userRole = req.user.role || 'USER';

      // Normalize roles (handle both uppercase and lowercase)
      const normalizedUserRole = userRole.toUpperCase();
      const normalizedAllowedRoles = allowedRoles.map(role => 
        typeof role === 'string' ? role.toUpperCase() : role
      );

      // Check if user's role is in allowed roles
      if (!normalizedAllowedRoles.includes(normalizedUserRole)) {
        // Log unauthorized access attempt (if AuditLog exists)
        try {
          if (AuditLog) {
            await AuditLog.logAction({
              actorId: req.user._id,
              actorRole: userRole,
              actorEmail: req.user.email,
              action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
              targetType: 'SYSTEM',
              details: {
                requestedPath: req.path,
                requestedMethod: req.method,
                requiredRoles: allowedRoles,
                userRole: userRole
              },
              ipAddress: req.ip,
              userAgent: req.get('user-agent'),
              requestMethod: req.method,
              requestPath: req.path,
              isSuccessful: false
            });
          }
        } catch (auditError) {
          console.error('Audit log error:', auditError);
        }

        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions',
          required: allowedRoles,
          current: userRole
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
const requirePermission = (permission) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const userRole = req.user.role || 'USER';

      // Super admin has all permissions (handle both cases)
      if (userRole.toUpperCase() === 'SUPER_ADMIN') {
        return next();
      }

      // Check specific permission (if hasPermission method exists)
      if (req.user.hasPermission && !req.user.hasPermission(permission)) {
        return res.status(403).json({
          success: false,
          message: `Missing permission: ${permission}`
        });
      }

      // If hasPermission method doesn't exist, check adminPermissions directly
      if (!req.user.hasPermission && req.user.adminPermissions) {
        if (!req.user.adminPermissions[permission]) {
          return res.status(403).json({
            success: false,
            message: `Missing permission: ${permission}`
          });
        }
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
const canPerformAction = (action) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // If canPerformAction method exists, use it
      if (req.user.canPerformAction && !req.user.canPerformAction(action)) {
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
// ADMIN-ONLY MIDDLEWARE (Shortcuts)
// =============================================
/**
 * Ensure user is SAFETY_ADMIN or SUPER_ADMIN
 */
const adminOnly = authorize('SAFETY_ADMIN', 'SUPER_ADMIN', 'admin', 'moderator');

/**
 * Ensure user is SUPER_ADMIN only
 */
const superAdminOnly = authorize('SUPER_ADMIN', 'admin');

/**
 * Ensure user is regular USER only
 */
const userOnly = authorize('USER', 'user');

// =============================================
// MODERATOR MIDDLEWARE (for backward compatibility)
// =============================================
const moderatorOnly = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const userRole = req.user.role || 'user';
    const allowedRoles = ['admin', 'moderator', 'SAFETY_ADMIN', 'SUPER_ADMIN'];
    
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Moderator or Admin access required'
      });
    }

    next();
  } catch (error) {
    console.error('Moderator check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// =============================================
// AUDIT LOGGING MIDDLEWARE
// =============================================
/**
 * Automatically log admin actions
 * Usage: auditLog('VIEW_REPORT')
 */
const auditLog = (action, targetType = 'SYSTEM') => {
  return async (req, res, next) => {
    // Only log if AuditLog model exists
    if (!AuditLog) {
      return next();
    }

    // Store start time
    const startTime = Date.now();
    
    // Capture original send function
    const originalSend = res.send;
    
    // Override send function to log after response
    res.send = function (data) {
      // Calculate response time
      const responseTime = Date.now() - startTime;
      
      // Log the action (async, don't wait)
      if (req.user && (req.user.role === 'SAFETY_ADMIN' || req.user.role === 'SUPER_ADMIN' || req.user.role === 'admin' || req.user.role === 'moderator')) {
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
// EXPORTS
// =============================================
module.exports = {
  // Primary exports (new names)
  authenticate,
  authorize,
  requirePermission,
  canPerformAction,
  auditLog,
  
  // Backward compatibility (old names)
  auth,  // ✅ This is the key export for backward compatibility
  adminOnly,
  superAdminOnly,
  userOnly,
  moderatorOnly
};
