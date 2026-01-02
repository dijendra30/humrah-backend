// routes/auth.js - Enhanced Authentication Routes with Role Support
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { authenticate, superAdminOnly, auditLog } = require('../middleware/auth');
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');

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
      role: 'USER', // EXPLICIT: Public registration only creates USER role
      status: emailVerified ? 'ACTIVE' : 'PENDING_VERIFICATION',
      emailVerified: emailVerified || false,
      questionnaire: questionnaire || {}
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id, user.role);

    // Send welcome email if verified
    if (emailVerified) {
      try {
        await sendWelcomeEmail(user.email, user.firstName);
      } catch (emailError) {
        console.error('Welcome email error:', emailError);
      }
    }

    console.log(`✅ New user registered: ${user.email} (${user.role})`);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
        status: user.status
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

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find user (include password for comparison)
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if account is locked
    if (user.isLocked()) {
      return res.status(403).json({
        success: false,
        message: 'Account is temporarily locked due to multiple failed login attempts'
      });
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    
    if (!isMatch) {
      // Increment failed attempts
      await user.incLoginAttempts();
      
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check account status
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status.toLowerCase()}`,
        status: user.status
      });
    }

    // Check if suspended
    if (user.suspensionInfo?.isSuspended) {
      return res.status(403).json({
        success: false,
        message: 'Account is suspended',
        suspensionInfo: {
          reason: user.suspensionInfo.suspensionReason,
          until: user.suspensionInfo.suspendedUntil,
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

    // Reset login attempts on successful login
    if (user.loginAttempts > 0) {
      await user.resetLoginAttempts();
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    // Generate token (includes role)
    const token = generateToken(user._id, user.role);

    console.log(`✅ Login successful: ${user.email} (${user.role})`);

    // Log admin logins
    if (user.role !== 'USER') {
      await AuditLog.logAction({
        actorId: user._id,
        actorRole: user.role,
        actorEmail: user.email,
        action: 'ADMIN_LOGIN',
        targetType: 'SYSTEM',
        details: {
          loginTime: new Date()
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
    }

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role, // ✅ CRITICAL: Return role to frontend
        profilePhoto: user.profilePhoto,
        emailVerified: user.emailVerified,
        verified: user.verified,
        status: user.status,
        adminPermissions: user.adminPermissions // Include for admin users
      }
    });

  } catch (error) {
    console.error('Login error:', error);
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

    // Store OTP temporarily (you might want to use Redis for this)
    // For now, we'll use a simple approach
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
    // User is already attached by authenticate middleware
    // and includes fresh data from database
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
router.post(
  '/create-admin',
  authenticate,
  superAdminOnly,
  auditLog('CREATE_ADMIN', 'ADMIN'),
  async (req, res) => {
    try {
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
        status: 'ACTIVE',
        emailVerified: true,
        verified: true,
        adminPermissions: permissions,
        createdBy: req.user._id
      });

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
          adminPermissions: admin.adminPermissions,
          status: admin.status
        }
      });

    } catch (error) {
      console.error('Create admin error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create admin account'
      });
    }
  }
);

/**
 * @route   PUT /api/auth/update-admin-role
 * @desc    Update admin role or permissions (SUPER_ADMIN only)
 * @access  Private (SUPER_ADMIN)
 */
router.put(
  '/update-admin-role',
  authenticate,
  superAdminOnly,
  auditLog('UPDATE_ADMIN_ROLE', 'ADMIN'),
  async (req, res) => {
    try {
      const { adminId, role, permissions } = req.body;

      if (!adminId) {
        return res.status(400).json({
          success: false,
          message: 'Admin ID is required'
        });
      }

      const admin = await User.findById(adminId);
      
      if (!admin) {
        return res.status(404).json({
          success: false,
          message: 'Admin not found'
        });
      }

      // Prevent changing own role
      if (admin._id.toString() === req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Cannot modify your own role'
        });
      }

      // Update role if provided
      if (role && ['USER', 'SAFETY_ADMIN', 'SUPER_ADMIN'].includes(role)) {
        admin.role = role;
      }

      // Update permissions if provided
      if (permissions) {
        admin.adminPermissions = permissions;
      }

      await admin.save();

      console.log(`✅ Admin updated: ${admin.email} - new role: ${admin.role}`);

      res.json({
        success: true,
        message: 'Admin role updated successfully',
        user: {
          _id: admin._id,
          email: admin.email,
          role: admin.role,
          adminPermissions: admin.adminPermissions
        }
      });

    } catch (error) {
      console.error('Update admin role error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update admin role'
      });
    }
  }
);

module.exports = router;
