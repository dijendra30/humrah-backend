// routes/auth.js - CORRECTED Authentication Routes with OTP
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/auth');

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'fallback_secret', {
    expiresIn: '30d'
  });
};

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// ==================== NEW APPROACH ====================
// Store pending registrations in memory (or use Redis in production)
const pendingRegistrations = new Map();

// @route   POST /api/auth/send-otp-registration
// @desc    Send OTP for new user registration (NO DATABASE SAVE YET)
// @access  Public
router.post('/send-otp-registration', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { email } = req.body;

    // Check if user already exists in database
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'User with this email already exists' 
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP temporarily (NOT in database yet)
    pendingRegistrations.set(email, {
      otp,
      otpExpires,
      verified: false
    });

    // Log OTP in test mode
    if (process.env.OTP_TEST_MODE === 'true') {
      console.log('\n' + '='.repeat(60));
      console.log('📧 NEW USER REGISTRATION - OTP SENT (NOT SAVED YET)');
      console.log('='.repeat(60));
      console.log(`📮 Email: ${email}`);
      console.log(`🔐 OTP: ${otp}`);
      console.log(`⏰ Expires: ${otpExpires.toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    // Send email
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, 'User');
      } catch (error) {
        console.error('Failed to send email:', error);
      }
    }

    res.json({
      success: true,
      message: 'OTP sent to your email. Please verify to continue registration.',
      email: email,
      expiresIn: '10 minutes'
    });

  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while sending OTP' 
    });
  }
});

// @route   POST /api/auth/verify-otp-registration
// @desc    Verify OTP for registration (mark as verified, still NO database save)
// @access  Public
router.post('/verify-otp-registration', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { email, otp } = req.body;

    // Check pending registration
    const pendingReg = pendingRegistrations.get(email);

    if (!pendingReg) {
      return res.status(400).json({ 
        success: false, 
        message: 'No OTP found. Please request a new OTP.' 
      });
    }

    // Check if OTP expired
    if (new Date() > pendingReg.otpExpires) {
      pendingRegistrations.delete(email);
      return res.status(400).json({ 
        success: false, 
        message: 'OTP has expired. Please request a new one.' 
      });
    }

    // Verify OTP
    if (pendingReg.otp !== otp) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid OTP. Please check and try again.' 
      });
    }

    // Mark as verified (but DON'T save to database yet)
    pendingReg.verified = true;
    pendingRegistrations.set(email, pendingReg);

    console.log(`✅ OTP verified for ${email} - Ready for questionnaire`);

    res.json({
      success: true,
      message: 'Email verified successfully! Please complete the questionnaire.',
      verified: true
    });

  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during verification' 
    });
  }
});

// @route   POST /api/auth/register
// @desc    Complete registration with questionnaire (FINAL DATABASE SAVE)
// @access  Public
router.post('/register', [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('emailVerified').isBoolean().withMessage('Email verification status required')
], async (req, res) => {
  try {
    // Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { firstName, lastName, email, password, questionnaire, emailVerified } = req.body;

    // ✅ CHECK 1: Verify email was verified via OTP
    const pendingReg = pendingRegistrations.get(email);
    
    if (!emailVerified || !pendingReg || !pendingReg.verified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email must be verified before completing registration' 
      });
    }

    // ✅ CHECK 2: User should NOT exist in database yet
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      // Clean up pending registration
      pendingRegistrations.delete(email);
      return res.status(400).json({ 
        success: false, 
        message: 'User with this email already exists' 
      });
    }

    // ✅ NOW SAVE TO DATABASE (first and only time)
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      questionnaire: questionnaire || {},
      verified: true, // Already verified via OTP
      emailVerificationOTP: undefined, // No need to store OTP
      emailVerificationExpires: undefined
    });

    await user.save();

    // Clean up pending registration
    pendingRegistrations.delete(email);

    // Send welcome email
    if (process.env.BREVO_API_KEY) {
      sendWelcomeEmail(email, firstName).catch(err => 
        console.log('Welcome email failed:', err)
      );
    }

    // Generate token
    const token = generateToken(user._id);

    console.log(`✅ User registered successfully: ${email}`);

    res.status(201).json({
      success: true,
      message: 'Registration completed successfully!',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        isPremium: user.isPremium,
        verified: user.verified,
        questionnaire: user.questionnaire
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

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }

    // Check if email is verified
    if (!user.verified) {
      return res.status(403).json({ 
        success: false, 
        message: 'Please verify your email before logging in.',
        requiresVerification: true,
        email: user.email
      });
    }

    // Update last active
    user.lastActive = Date.now();
    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        isPremium: user.isPremium,
        verified: user.verified,
        questionnaire: user.questionnaire
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

// Keep all other routes (send-otp, verify-otp, resend-otp, /me, google, facebook) unchanged...
// Copy them from your original file

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      user
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   POST /api/auth/google
// @desc    Google OAuth login/register
// @access  Public
router.post('/google', async (req, res) => {
  try {
    const { googleId, email, firstName, lastName, profilePhoto } = req.body;

    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (user) {
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save();
      }
    } else {
      user = new User({
        googleId,
        email,
        firstName,
        lastName,
        profilePhoto,
        verified: true
      });
      await user.save();
    }

    user.lastActive = Date.now();
    await user.save();

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Google authentication successful',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        isPremium: user.isPremium,
        verified: user.verified
      }
    });

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Google authentication failed' 
    });
  }
});

// @route   POST /api/auth/facebook
// @desc    Facebook OAuth login/register
// @access  Public
router.post('/facebook', async (req, res) => {
  try {
    const { facebookId, email, firstName, lastName, profilePhoto } = req.body;

    let user = await User.findOne({ $or: [{ facebookId }, { email }] });

    if (user) {
      if (!user.facebookId) {
        user.facebookId = facebookId;
        await user.save();
      }
    } else {
      user = new User({
        facebookId,
        email,
        firstName,
        lastName,
        profilePhoto,
        verified: true
      });
      await user.save();
    }

    user.lastActive = Date.now();
    await user.save();

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Facebook authentication successful',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        isPremium: user.isPremium,
        verified: user.verified
      }
    });

  } catch (error) {
    console.error('Facebook auth error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Facebook authentication failed' 
    });
  }
});

module.exports = router;
