// routes/auth.js - Simplified Authentication Routes (Works with Current User Model)
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');

// Import auth middleware (use 'auth' for backward compatibility)
let authenticate, superAdminOnly, auditLog;
try {
  const authMiddleware = require('../middleware/auth');
  authenticate = authMiddleware.authenticate || authMiddleware.auth;
  superAdminOnly = authMiddleware.superAdminOnly;
  auditLog = authMiddleware.auditLog || ((action, type) => (req, res, next) => next());
} catch (error) {
  console.error('Error loading auth middleware:', error);
  // Fallback simple auth
  authenticate = async (req, res, next) => {
    try {
      const token = req.header('Authorization')?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ success: false, message: 'No token' });
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_change_in_production');
      const user = await User.findById(decoded.userId).select('-password');
      if (!user) return res.status(401).json({ success: false, message: 'User not found' });
      
      req.user = user;
      req.userId = user._id;
      next();
    } catch (error) {
      res.status(401).json({ success: false, message: 'Invalid token' });
    }
  };
}

// =============================================
// HELPER: GENERATE JWT TOKEN
// =============================================
const generateToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET || 'fallback_secret_change_in_production',
    { expiresIn: '7d' }
  );
};


// =============================================
// PUBLIC ROUTES
// =============================================

/**
 * @route   POST /api/auth/register
 * @desc    Register new user (USER role only)
 * @access  Public
 */
router.post('/register', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      questionnaire,
      emailVerified
    } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // Create user (ALWAYS with USER role)
    const user = new User({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password,
      role: 'USER',
      emailVerified: emailVerified || false,
      questionnaire: questionnaire || {}
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id, user.role || 'USER');

    // Send welcome email if verified
    if (emailVerified) {
      try {
        await sendWelcomeEmail(user.email, user.firstName);
      } catch (emailError) {
        console.error('Welcome email error:', emailError);
      }
    }

    console.log(`✅ New user registered: ${user.email}`);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role || 'USER',
        emailVerified: user.emailVerified
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
});

/**
 * @route   POST /api/auth/login
 * @desc    Login user (all roles use same endpoint)
 * @access  Public
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log('🔍 Login attempt for:', email);

    // Validation
    if (!email || !password) {
      console.log('❌ Missing email or password');
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find user (include password for comparison)
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    
    console.log('👤 User found:', !!user);
    if (user) {
      console.log('📧 User email:', user.email);
      console.log('🔑 User role:', user.role);
      console.log('🔐 Password hash exists:', !!user.password);
      console.log('📊 User status:', user.status);
    }
    
    if (!user) {
      console.log('❌ User not found in database');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Verify password
    let isMatch = false;
    try {
      isMatch = await user.comparePassword(password);
      console.log('🔓 Password match result:', isMatch);
    } catch (compareError) {
      console.error('❌ Password comparison error:', compareError);
      return res.status(500).json({
        success: false,
        message: 'Server error during login'
      });
    }
    
    if (!isMatch) {
      console.log('❌ Password does not match');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check account status (if field exists)
    if (user.status && user.status !== 'ACTIVE') {
      console.log('❌ Account not active, status:', user.status);
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status.toLowerCase()}`
      });
    }

    // Update last active
    try {
      user.lastActive = new Date();
      await user.save();
    } catch (saveError) {
      console.log('⚠️ Could not update lastActive:', saveError.message);
      // Continue anyway
    }

    // Get role (handle both old and new User models)
    const userRole = user.role || 'USER';

    // Generate token (includes role)
    const token = generateToken(user._id, userRole);

    console.log(`✅ Login successful: ${user.email} (${userRole})`);

    // Prepare user response
    const userResponse = {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: userRole,
      profilePhoto: user.profilePhoto,
      emailVerified: user.emailVerified,
      verified: user.verified
    };

    // Add admin permissions if available
    if (user.adminPermissions) {
      userResponse.adminPermissions = user.adminPermissions;
    }

    // Add status if available
    if (user.status) {
      userResponse.status = user.status;
    }

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: userResponse
    });

  } catch (error) {
    console.error('💥 Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

/**
 * @route   POST /api/auth/send-otp-registration
 * @desc    Send OTP for email verification during registration
 * @access  Public
 */
router.post('/send-otp-registration', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP temporarily
    global.otpStore = global.otpStore || {};
    global.otpStore[email.toLowerCase()] = {
      otp,
      expires
    };

    // Send OTP email
    await sendOTPEmail(email, otp);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      emailSent: true
    });

  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP'
    });
  }
});

/**
 * @route   POST /api/auth/verify-otp-registration
 * @desc    Verify OTP during registration
 * @access  Public
 */
router.post('/verify-otp-registration', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required'
      });
    }

    // Check OTP
    const storedOTP = global.otpStore?.[email.toLowerCase()];
    
    if (!storedOTP) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found or expired'
      });
    }

    if (new Date() > storedOTP.expires) {
      delete global.otpStore[email.toLowerCase()];
      return res.status(400).json({
        success: false,
        message: 'OTP expired'
      });
    }

    if (storedOTP.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    // Clear OTP
    delete global.otpStore[email.toLowerCase()];

    res.json({
      success: true,
      message: 'Email verified successfully',
      verified: true
    });

  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP'
    });
  }
});

// =============================================
// PROTECTED ROUTES
// =============================================

/**
 * @route   GET /api/auth/me
 * @desc    Get current user info (refreshes role from DB)
 * @access  Private
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user data'
    });
  }
});

// =============================================
// ADMIN CREATION (SUPER_ADMIN ONLY)
// =============================================

/**
 * @route   POST /api/auth/create-admin
 * @desc    Create new admin account (SUPER_ADMIN only)
 * @access  Private (SUPER_ADMIN)
 */
router.post('/create-admin', authenticate, async (req, res) => {
  try {
    // Check if user is super admin
    if (!req.user || req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Super admin access required'
      });
    }

    const {
      firstName,
      lastName,
      email,
      password,
      role,
      permissions
    } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Validate role
    if (!['SAFETY_ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid admin role'
      });
    }

    // Check if email exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // Create admin user
    const admin = new User({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password,
      role,
      emailVerified: true,
      verified: true,
      adminPermissions: permissions
    });

    // Set status if field exists
    if (admin.status !== undefined) {
      admin.status = 'ACTIVE';
    }

    await admin.save();

    console.log(`✅ Admin created: ${admin.email} (${admin.role}) by ${req.user.email}`);

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      user: {
        _id: admin._id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        role: admin.role,
        adminPermissions: admin.adminPermissions
      }
    });

  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create admin account'
    });
  }
});
// Add this TEMPORARILY to your routes/auth.js file
// Put it at the bottom, before module.exports

/**
 * ⚠️ EMERGENCY ENDPOINT - DELETE AFTER USE!
 * @route   POST /api/auth/emergency-super-admin
 * @desc    Create super admin with proper password hashing
 * @access  Public (REMOVE AFTER USE!)
 */
router.post('/emergency-super-admin', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('🚨 Emergency super admin creation');
    console.log('Email:', email);
    console.log('Password length:', password?.length);
    
    // Delete existing user if exists
    const deleted = await User.deleteOne({ email: email || "dijendra@humrah.in" });
    console.log('Deleted existing user:', deleted.deletedCount > 0);
    
    // Create new super admin (password will be auto-hashed by pre-save hook)
    const admin = new User({
      firstName: "Dijendra",
      lastName: "Mondal",
      email: email || "dijendra@humrah.in",
      password: password || "Admin123!",  // Will be auto-hashed
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      emailVerified: true,
      verified: true
    });
    
    await admin.save();
    
    console.log('✅ Super admin created');
    console.log('Password was hashed:', admin.password.startsWith('$2'));
    
    res.json({
      success: true,
      message: "Super admin created successfully",
      email: admin.email,
      role: admin.role,
      passwordHashed: admin.password.startsWith('$2'),
      loginWith: {
        email: admin.email,
        password: password || "Admin123!"
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ⚠️ REMEMBER TO DELETE THIS ENDPOINT AFTER USE!

module.exports = router;



