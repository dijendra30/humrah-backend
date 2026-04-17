// routes/auth.js - UPDATED WITH LEGAL ACCEPTANCE + PASSWORD VALIDATION
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const LegalAcceptance = require('../models/LegalAcceptance');
const LegalVersion = require('../models/LegalVersion');
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');
const { isStrongPassword } = require('../utils/passwordValidator');

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
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
// ENV VALIDATION — fail fast if JWT_SECRET missing
// =============================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    '[auth.js route] JWT_SECRET environment variable is not set. ' +
    'Add it to your .env file and restart the server.'
  );
}

// =============================================
// HELPER: GENERATE JWT TOKEN
// =============================================
const generateToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};


// =============================================
// PUBLIC ROUTES
// =============================================

/**
 * @route   POST /api/auth/register
 * @desc    Register new user with legal acceptance (USER role only)
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
      emailVerified,
      legalAcceptance  // ✅ NEW: Legal acceptance data
    } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // ✅ PASSWORD STRENGTH VALIDATION (server always validates, never trusts client)
    const passwordCheck = isStrongPassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({
        success: false,
        message: passwordCheck.message
      });
    }

    // ✅ VALIDATE LEGAL ACCEPTANCE
    if (!legalAcceptance || 
        !legalAcceptance.termsVersion || 
        !legalAcceptance.privacyVersion ||
        !legalAcceptance.deviceFingerprint ||
        !legalAcceptance.platform) {
      return res.status(400).json({
        success: false,
        message: 'Legal acceptance required',
        code: 'LEGAL_ACCEPTANCE_MISSING'
      });
    }

    // ✅ VERIFY LEGAL VERSIONS ARE CURRENT
    const [termsDoc, privacyDoc] = await Promise.all([
      LegalVersion.findOne({ documentType: 'TERMS' }),
      LegalVersion.findOne({ documentType: 'PRIVACY' })
    ]);
    
    if (!termsDoc || !privacyDoc) {
      return res.status(500).json({
        success: false,
        message: 'Legal versions not configured'
      });
    }
    
    if (legalAcceptance.termsVersion !== termsDoc.currentVersion || 
        legalAcceptance.privacyVersion !== privacyDoc.currentVersion) {
      return res.status(400).json({
        success: false,
        message: 'Version mismatch. Please refresh and accept current versions.',
        currentVersions: {
          terms: termsDoc.currentVersion,
          privacy: privacyDoc.currentVersion
        }
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

    // Get IP address
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';

    // Create user (ALWAYS with USER role)
    const user = new User({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password,
      role: 'USER',
      emailVerified: emailVerified || false,
      questionnaire: questionnaire || {},
      // ✅ NEW: Legal acceptance fields
      acceptedTermsVersion: legalAcceptance.termsVersion,
      acceptedPrivacyVersion: legalAcceptance.privacyVersion,
      lastLegalAcceptanceDate: new Date()
    });

    await user.save();

    // ✅ LOG LEGAL ACCEPTANCE
    const acceptance = new LegalAcceptance({
      userId: user._id,
      documentType: 'BOTH',
      termsVersion: legalAcceptance.termsVersion,
      privacyVersion: legalAcceptance.privacyVersion,
      acceptedAt: new Date(),
      ipAddress,
      deviceFingerprint: legalAcceptance.deviceFingerprint,
      userAgent: req.get('user-agent'),
      platform: legalAcceptance.platform,
      appVersion: legalAcceptance.appVersion
    });
    
    await acceptance.save();

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
 * @desc    Login user and check legal acceptance (all roles use same endpoint)
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

    // ── Check account status ──────────────────────────────────────────────────
    if (user.status && user.status !== 'ACTIVE') {

      // ── Auto-lift suspension if suspendedUntil has passed ──────────────────
      if (
        user.status === 'SUSPENDED' &&
        user.suspensionInfo?.suspendedUntil &&
        new Date() >= new Date(user.suspensionInfo.suspendedUntil)
      ) {
        // Suspension period expired → restore account automatically
        user.status                           = 'ACTIVE';
        user.suspensionInfo.isSuspended       = false;
        user.suspensionInfo.suspendedUntil    = null;
        user.suspensionInfo.autoLiftAt        = null;
        user.suspensionInfo.suspensionReason  = null;
        await user.save();
        console.log(`✅ Auto-lifted suspension for ${user.email}`);
        // fall through to normal login
      } else if (user.status === 'SUSPENDED') {
        const until = user.suspensionInfo?.suspendedUntil;
        return res.status(403).json({
          success: false,
          message: 'Your account has been temporarily restricted due to community reports.',
          suspensionInfo: {
            reason:       user.suspensionInfo?.suspensionReason || 'Community guideline violation',
            suspendedUntil: until ? until.toISOString() : null,
            // human readable e.g. "Restrictions lift on March 21, 2026"
            liftsOn: until
              ? new Date(until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
              : 'indefinite'
          }
        });
      } else if (user.status === 'BANNED') {
        return res.status(403).json({
          success: false,
          message: 'This account has been permanently banned.',
        });
      } else {
        return res.status(403).json({
          success: false,
          message: `Account is ${user.status.toLowerCase()}`
        });
      }
    }

    // ✅ CHECK LEGAL ACCEPTANCE STATUS
    let hasAcceptedCurrent = false;
    try {
      hasAcceptedCurrent = await user.hasAcceptedCurrentLegal();
    } catch (legalError) {
      console.log('⚠️ Could not check legal acceptance:', legalError.message);
      // Continue with login, but flag for re-acceptance
      hasAcceptedCurrent = false;
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
      verified: user.verified,
      questionnaire: user.questionnaire,  // ADD THIS
      isPremium: user.isPremium || false,  // ADD THIS
      paymentInfo: user.paymentInfo || null, // ADD THIS
      hostActive: user.hostActive !== false, // ADD THIS
    };

    // Add admin permissions if available
    if (user.adminPermissions) {
      userResponse.adminPermissions = user.adminPermissions;
    }

    // Add status if available
    if (user.status) {
      userResponse.status = user.status;
    }

    // ✅ GET CURRENT VERSIONS IF RE-ACCEPTANCE NEEDED
    let currentVersions = null;
    if (!hasAcceptedCurrent) {
      try {
        const [termsDoc, privacyDoc] = await Promise.all([
          LegalVersion.findOne({ documentType: 'TERMS' }),
          LegalVersion.findOne({ documentType: 'PRIVACY' })
        ]);
        
        currentVersions = {
          terms: {
            version: termsDoc?.currentVersion,
            url: termsDoc?.url
          },
          privacy: {
            version: privacyDoc?.currentVersion,
            url: privacyDoc?.url
          }
        };
      } catch (versionError) {
        console.log('⚠️ Could not fetch legal versions:', versionError.message);
      }
    }

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: userResponse,
      // ✅ INCLUDE LEGAL STATUS
      requiresLegalReacceptance: !hasAcceptedCurrent,
      currentVersions: currentVersions
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

    // ✅ Get current legal versions for admin creation
    let currentTermsVersion = '1.0.0';
    let currentPrivacyVersion = '1.0.0';
    try {
      const [termsDoc, privacyDoc] = await Promise.all([
        LegalVersion.findOne({ documentType: 'TERMS' }),
        LegalVersion.findOne({ documentType: 'PRIVACY' })
      ]);
      if (termsDoc) currentTermsVersion = termsDoc.currentVersion;
      if (privacyDoc) currentPrivacyVersion = privacyDoc.currentVersion;
    } catch (err) {
      console.log('Could not fetch legal versions for admin creation');
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
      adminPermissions: permissions,
      // ✅ Set legal acceptance for admin (auto-accepted)
      acceptedTermsVersion: currentTermsVersion,
      acceptedPrivacyVersion: currentPrivacyVersion,
      lastLegalAcceptanceDate: new Date()
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

module.exports = router;
