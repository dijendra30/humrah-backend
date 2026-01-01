// middleware/auth.js - Authentication & Authorization Middleware
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// =====================
// AUTHENTICATION MIDDLEWARE
// =====================
exports.auth = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.replace('Bearer ', '')
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token, access denied'
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'fallback_secret'
    );

    // Fetch user from DB (needed for role, status, etc.)
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

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

    return res.status(401).json({
      success: false,
      message: 'Token is not valid'
    });
  }
};

// =====================
// ADMIN AUTHORIZATION MIDDLEWARE
// =====================
exports.adminOnly = async (req, res, next) => {
  try {
    // Check if user is attached (auth middleware should run first)
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Check if user has admin role
    // TODO: Add 'role' field to User model if not present
    // For now, you can use email-based check or add role field
    
    // Option 1: Check by email (temporary solution)
    const adminEmails = [
      'admin@humrah.com',
      'safety@humrah.com'
      // Add your admin emails here
    ];
    
    if (!adminEmails.includes(req.user.email)) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }

    // Option 2: Check by role field (recommended - add to User model)
    // if (req.user.role !== 'admin') {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Admin access required'
    //   });
    // }

    next();
  } catch (error) {
    console.error('Admin check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// =====================
// OPTIONAL: MODERATOR MIDDLEWARE
// =====================
exports.moderatorOnly = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Check if user is admin or moderator
    const allowedRoles = ['admin', 'moderator'];
    
    // TODO: Add role field to User model
    // if (!allowedRoles.includes(req.user.role)) {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Moderator or Admin access required'
    //   });
    // }

    next();
  } catch (error) {
    console.error('Moderator check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
