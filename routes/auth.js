// routes/auth.js - Authentication Routes with CORRECTED Three-Step Registration
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/auth');

// ==================== IN-MEMORY STORAGE ====================
// Store pending registrations temporarily (email → registration data)
const pendingRegistrations = new Map();

// Cleanup expired registrations every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of pendingRegistrations.entries()) {
    if (now > data.expiresAt) {
      pendingRegistrations.delete(email);
      console.log(`🗑️ Cleaned up expired registration for: ${email}`);
    }
  }
}, 15 * 60 * 1000);

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

// ==================== STEP 1: SEND OTP FOR REGISTRATION ====================
// @route   POST /api/auth/send-otp-registration
// @desc    Send OTP for new registration (NO DATABASE SAVE)
// @access  Public
router.post('/send-otp-registration', [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { firstName, lastName, email, password } = req.body;

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
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store in memory (NOT in database)
    pendingRegistrations.set(email, {
      firstName,
      lastName,
      email,
      password,
      otp,
      expiresAt,
      verified: false
    });

    // Log OTP in test mode
    if (process.env.OTP_TEST_MODE === 'true') {
      console.log('\n' + '='.repeat(60));
      console.log('📧 REGISTRATION OTP SENT (STEP 1)');
      console.log('='.repeat(60));
      console.log(`📮 Email: ${email}`);
      console.log(`👤 User: ${firstName} ${lastName}`);
      console.log(`🔐 OTP: ${otp}`);
      console.log(`⏰ Expires: ${new Date(expiresAt).toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    // Send actual email (only if Brevo is configured)
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, firstName);
      } catch (error) {
        console.error('Failed to send email, but OTP is still valid:', error);
      }
    }

    res.json({
      success: true,
      message: 'OTP sent to your email. Please verify within 10 minutes.',
      email: email,
      expiresIn: '10 minutes'
    });

  } catch (error) {
    console.error('Send OTP Registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while sending OTP' 
    });
  }
});

// ==================== STEP 2: VERIFY OTP ====================
// @route   POST /api/auth/verify-otp-registration
// @desc    Verify OTP for registration (NO DATABASE SAVE)
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

    // Check if registration exists in memory
    const registration = pendingRegistrations.get(email);
    
    if (!registration) {
      return res.status(400).json({ 
        success: false, 
        message: 'No pending registration found. Please start registration again.' 
      });
    }

    // Check if expired
    if (Date.now() > registration.expiresAt) {
      pendingRegistrations.delete(email);
      return res.status(400).json({ 
        success: false, 
        message: 'OTP has expired. Please start registration again.' 
      });
    }

    // Verify OTP
    if (registration.otp !== otp) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid OTP. Please check and try again.' 
      });
    }

    // Mark as verified in memory (NOT in database)
    registration.verified = true;
    pendingRegistrations.set(email, registration);

    console.log(`✅ OTP VERIFIED (STEP 2) for: ${email}`);

    res.json({
      success: true,
      message: 'Email verified successfully! Please complete the questionnaire.',
      verified: true
    });

  } catch (error) {
    console.error('Verify OTP Registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during verification' 
    });
  }
});

// ==================== STEP 3: COMPLETE REGISTRATION ====================
// @route   POST /api/auth/register
// @desc    Complete registration with questionnaire (SINGLE DATABASE SAVE)
// @access  Public
router.post('/register', [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('emailVerified').isBoolean().withMessage('Email verification status required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { firstName, lastName, email, password, questionnaire, emailVerified } = req.body;

    // Verify OTP was completed
    const registration = pendingRegistrations.get(email);
    if (!registration || !registration.verified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email verification required. Please verify OTP first.' 
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'User with this email already exists' 
      });
    }

    // Create user with ALL data in ONE save
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      questionnaire: questionnaire || {},
      verified: emailVerified || registration.verified
    });

    await user.save();

    // Clean up memory
    pendingRegistrations.delete(email);

    console.log(`✅ REGISTRATION COMPLETE (STEP 3) for: ${email}`);
    console.log(`📊 Questionnaire saved: ${questionnaire ? 'Yes' : 'No'}`);

    // Send welcome email (optional)
    if (process.env.BREVO_API_KEY) {
      sendWelcomeEmail(email, user.firstName).catch(err => 
        console.log('Welcome email failed:', err)
      );
    }

    // Generate token
    const token = generateToken(user._id);

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
        verified: user.verified
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

// ==================== EXISTING LOGIN ENDPOINT ====================
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
        message: 'Please verify your email before logging in. Check your inbox for OTP.',
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

// ==================== LEGACY OTP ENDPOINTS (Keep for existing verified users) ====================
// @route   POST /api/auth/send-otp
// @desc    Send OTP to email for existing users
// @access  Public
router.post('/send-otp', [
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

    // Check if user exists
    let user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'No account found with this email. Please register first.' 
      });
    }

    // Check if already verified
    if (user.verified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is already verified. You can login now.' 
      });
    }

    // Generate OTP
    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    if (process.env.OTP_TEST_MODE === 'true') {
      console.log('\n' + '='.repeat(60));
      console.log('📧 OTP EMAIL VERIFICATION (EXISTING USER)');
      console.log('='.repeat(60));
      console.log(`📮 Email: ${email}`);
      console.log(`👤 User: ${user.firstName} ${user.lastName}`);
      console.log(`🔐 OTP: ${otp}`);
      console.log(`⏰ Expires: ${user.emailVerificationExpires.toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, user.firstName);
      } catch (error) {
        console.error('Failed to send email, but OTP is still valid:', error);
      }
    }

    res.json({
      success: true,
      message: 'OTP sent to your email. Please verify within 10 minutes.',
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

// @route   POST /api/auth/verify-otp
// @desc    Verify OTP and activate existing user account
// @access  Public
router.post('/verify-otp', [
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

    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    if (user.verified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is already verified' 
      });
    }

    if (!user.emailVerificationOTP) {
      return res.status(400).json({ 
        success: false, 
        message: 'No OTP found. Please request a new OTP.' 
      });
    }

    if (new Date() > user.emailVerificationExpires) {
      return res.status(400).json({ 
        success: false, 
        message: 'OTP has expired. Please request a new one.' 
      });
    }

    if (user.emailVerificationOTP !== otp) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid OTP. Please check and try again.' 
      });
    }

    user.verified = true;
    user.emailVerificationOTP = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    if (process.env.BREVO_API_KEY) {
      sendWelcomeEmail(email, user.firstName).catch(err => 
        console.log('Welcome email failed:', err)
      );
    }

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Email verified successfully!',
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
    console.error('Verify OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during verification' 
    });
  }
});

// @route   POST /api/auth/resend-otp
// @desc    Resend OTP to email
// @access  Public
router.post('/resend-otp', [
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
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'No account found with this email' 
      });
    }

    if (user.verified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is already verified' 
      });
    }

    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    if (process.env.OTP_TEST_MODE === 'true') {
      console.log('\n' + '='.repeat(60));
      console.log('📧 OTP RESEND');
      console.log('='.repeat(60));
      console.log(`📮 Email: ${email}`);
      console.log(`👤 User: ${user.firstName} ${user.lastName}`);
      console.log(`🔐 NEW OTP: ${otp}`);
      console.log(`⏰ Expires: ${user.emailVerificationExpires.toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    res.json({
      success: true,
      message: 'New OTP sent to your email',
      email: email,
      expiresIn: '10 minutes'
    });

  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while resending OTP' 
    });
  }
});

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
