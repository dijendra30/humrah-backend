// routes/auth.js - WITH EMAIL OTP VERIFICATION
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/auth');

// In-memory OTP storage (use Redis in production)
const otpStore = new Map();

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

// @route   POST /api/auth/send-otp
// @desc    Send OTP to email
// @access  Public
router.post('/send-otp', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email } = req.body;
    
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: `Welcome back! This email is already registered. Please login instead.` 
      });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    
    otpStore.set(email, { otp, expiresAt });

    // TODO: Send email using nodemailer or your email service
    console.log(`📧 OTP for ${email}: ${otp}`);
    
    // For development, return OTP in response (REMOVE IN PRODUCTION)
    res.json({
      success: true,
      message: 'OTP sent successfully to your email',
      devOtp: process.env.NODE_ENV === 'development' ? otp : undefined
    });

  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

// @route   POST /api/auth/verify-otp
// @desc    Verify OTP
// @access  Public
router.post('/verify-otp', [
  body('email').isEmail().normalizeEmail(),
  body('otp').isLength({ min: 6, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, otp } = req.body;
    
    const storedData = otpStore.get(email);
    
    if (!storedData) {
      return res.status(400).json({ 
        success: false, 
        message: 'OTP expired or not found. Please request a new OTP.' 
      });
    }

    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ 
        success: false, 
        message: 'OTP expired. Please request a new OTP.' 
      });
    }

    if (storedData.otp !== otp) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid OTP. Please try again.' 
      });
    }

    // OTP verified
    otpStore.delete(email);
    
    res.json({
      success: true,
      message: 'Email verified successfully! You can now complete registration.',
      verified: true
    });

  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// @route   POST /api/auth/register
// @desc    Register new user with questionnaire
// @access  Public
router.post('/register', [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('emailVerified').isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { firstName, lastName, email, password, questionnaire, emailVerified } = req.body;

    if (!emailVerified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please verify your email first' 
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: `Hello ${existingUser.firstName}! You're already registered. Please login instead.` 
      });
    }

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      questionnaire: questionnaire || {},
      verified: true
    });

    await user.save();
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: `Welcome to Humrah, ${user.firstName}! 🎉 Your account has been created successfully.`,
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        isPremium: user.isPremium
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'No account found with this email. Please register first.' 
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Incorrect password. Please try again.' 
      });
    }

    user.lastActive = Date.now();
    await user.save();

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: `Welcome back, ${user.firstName}! 👋`,
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        isPremium: user.isPremium,
        questionnaire: user.questionnaire
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
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
      const token = generateToken(user._id);
      return res.json({
        success: true,
        message: `Welcome back, ${user.firstName}! 👋`,
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          profilePhoto: user.profilePhoto,
          isPremium: user.isPremium
        },
        isNewUser: false
      });
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
      const token = generateToken(user._id);
      
      return res.json({
        success: true,
        message: `Welcome to Humrah, ${user.firstName}! 🎉 Let's set up your profile.`,
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          profilePhoto: user.profilePhoto,
          isPremium: user.isPremium
        },
        isNewUser: true,
        needsQuestionnaire: true
      });
    }

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ success: false, message: 'Authentication failed' });
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
      const token = generateToken(user._id);
      return res.json({
        success: true,
        message: `Welcome back, ${user.firstName}! 👋`,
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          profilePhoto: user.profilePhoto,
          isPremium: user.isPremium
        },
        isNewUser: false
      });
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
      const token = generateToken(user._id);
      
      return res.json({
        success: true,
        message: `Welcome to Humrah, ${user.firstName}! 🎉 Let's set up your profile.`,
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          profilePhoto: user.profilePhoto,
          isPremium: user.isPremium
        },
        isNewUser: true,
        needsQuestionnaire: true
      });
    }

  } catch (error) {
    console.error('Facebook auth error:', error);
    res.status(500).json({ success: false, message: 'Authentication failed' });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
