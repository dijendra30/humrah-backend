// routes/auth.js - Authentication Routes with OTP
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

// @route   POST /api/auth/register
// @desc    Register new user with questionnaire
// @access  Public
router.post('/register', [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
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

    const { firstName, lastName, email, password, questionnaire } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'User with this email already exists' 
      });
    }

    // Create user
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      questionnaire: questionnaire || {},
      verified: false // Not verified initially
    });

    // Generate OTP
    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await user.save();

    // Log OTP in test mode
    if (process.env.OTP_TEST_MODE === 'true') {
      console.log('\n' + '='.repeat(60));
      console.log('📧 NEW USER REGISTRATION - OTP SENT');
      console.log('='.repeat(60));
      console.log(`📮 Email: ${email}`);
      console.log(`👤 User: ${firstName} ${lastName}`);
      console.log(`🔐 OTP: ${otp}`);
      console.log(`⏰ Expires: ${user.emailVerificationExpires.toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Registration successful. Please verify your email with the OTP sent.',
      token,
      requiresOTP: true,
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

// ============================================
// OTP EMAIL VERIFICATION ENDPOINTS
// ============================================

// @route   POST /api/auth/send-otp
// @desc    Send OTP to email for verification
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
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save();

    // Log OTP in test mode
    if (process.env.OTP_TEST_MODE === 'true') {
      console.log('\n' + '='.repeat(60));
      console.log('📧 OTP EMAIL VERIFICATION');
      console.log('='.repeat(60));
      console.log(`📮 Email: ${email}`);
      console.log(`👤 User: ${user.firstName} ${user.lastName}`);
      console.log(`🔐 OTP: ${otp}`);
      console.log(`⏰ Expires: ${user.emailVerificationExpires.toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    // TODO: Send actual email with OTP using Brevo/SendGrid
    // For now, just return success in test mode
    
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
// @desc    Verify OTP and activate account
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

    // Find user
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Check if already verified
    if (user.verified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is already verified' 
      });
    }

    // Check if OTP exists
    if (!user.emailVerificationOTP) {
      return res.status(400).json({ 
        success: false, 
        message: 'No OTP found. Please request a new OTP.' 
      });
    }

    // Check if OTP expired
    if (new Date() > user.emailVerificationExpires) {
      return res.status(400).json({ 
        success: false, 
        message: 'OTP has expired. Please request a new one.' 
      });
    }

    // Verify OTP
    if (user.emailVerificationOTP !== otp) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid OTP. Please check and try again.' 
      });
    }

    // Mark as verified
    user.verified = true;
    user.emailVerificationOTP = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    // Generate token
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

    // Find user
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'No account found with this email' 
      });
    }

    // Check if already verified
    if (user.verified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is already verified' 
      });
    }

    // Generate new OTP
    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save();

    // Log OTP in test mode
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

    // TODO: Send actual email with OTP
    
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
      // Update Google ID if logging in with Google for first time
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save();
      }
    } else {
      // Create new user
      user = new User({
        googleId,
        email,
        firstName,
        lastName,
        profilePhoto,
        verified: true // Auto-verify OAuth users
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
        verified: true // Auto-verify OAuth users
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
