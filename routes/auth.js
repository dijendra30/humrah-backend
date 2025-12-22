// routes/auth.js - Authentication Routes with OTP
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');

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
// @desc    Register new user with questionnaire and send OTP
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
      verified: false
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

    // Send OTP email (only if Brevo is configured)
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, firstName);
        console.log('✅ OTP email sent successfully to:', email);
      } catch (emailError) {
        console.error('❌ Failed to send OTP email:', emailError);
        // Don't fail registration if email fails
      }
    } else {
      console.log('⚠️ BREVO_API_KEY not configured - OTP logged to console only');
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

    // Find user
    let user = await User.findOne({ email });
    
    if (!user) {
      // Create temporary user record for OTP verification
      user = new User({
        firstName: 'Temp',
        lastName: 'User',
        email,
        password: Math.random().toString(36).slice(-12), // Temporary password
        verified: false
      });
    }

    // Check if already verified
    if (user.verified && user.firstName !== 'Temp') {
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
      console.log(`👤 User: ${user.firstName === 'Temp' ? 'NEW USER' : user.firstName + ' ' + user.lastName}`);
      console.log(`🔐 OTP: ${otp}`);
      console.log(`⏰ Expires: ${user.emailVerificationExpires.toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    // Send email (only if Brevo is configured)
    if (process.env.BREVO_API_KEY) {
      try {
        const firstName = user.firstName === 'Temp' ? 'User' : user.firstName;
        await sendOTPEmail(email, otp, firstName);
        console.log('✅ OTP email sent successfully to:', email);
      } catch (emailError) {
        console.error('❌ Failed to send email, but OTP is still valid:', emailError);
      }
    } else {
      console.log('⚠️ BREVO_API_KEY not configured - OTP logged to console only');
    }
    
    res.json({
      success: true,
      message: 'OTP sent to your email. Please verify within 10 minutes.',
      email: email,
      expiresIn: '10 minutes',
      isNewUser: user.firstName === 'Temp'
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

    // Check if this is a temporary user (needs to complete registration)
    const isNewUser = user.firstName === 'Temp';

    if (isNewUser) {
      // Mark OTP as verified but don't fully verify account yet
      user.emailVerificationOTP = 'VERIFIED'; // Keep this to track OTP was verified
      await user.save();

      // Generate token for completing registration
      const token = generateToken(user._id);

      res.json({
        success: true,
        message: 'OTP verified! Please complete your registration.',
        requiresRegistration: true,
        token,
        user: {
          id: user._id,
          email: user.email,
          verified: false
        }
      });
    } else {
      // Existing user - fully verify
      user.verified = true;
      user.emailVerificationOTP = undefined;
      user.emailVerificationExpires = undefined;
      await user.save();

      // Send welcome email (optional)
      if (process.env.BREVO_API_KEY) {
        sendWelcomeEmail(email, user.firstName).catch(err => 
          console.log('Welcome email failed:', err)
        );
      }

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
    }

  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during verification' 
    });
  }
});

// @route   POST /api/auth/complete-registration
// @desc    Complete registration after OTP verification
// @access  Private (requires token from OTP verification)
router.post('/complete-registration', auth, [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
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

    const { firstName, lastName, password, questionnaire } = req.body;

    // Find user
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Check if OTP was verified
    if (user.emailVerificationOTP !== 'VERIFIED') {
      return res.status(400).json({ 
        success: false, 
        message: 'Please verify your OTP first' 
      });
    }

    // Check if already completed registration
    if (user.verified && user.firstName !== 'Temp') {
      return res.status(400).json({ 
        success: false, 
        message: 'Registration already completed' 
      });
    }

    // Update user with registration details
    user.firstName = firstName;
    user.lastName = lastName;
    user.password = password; // Will be hashed by pre-save hook
    user.questionnaire = questionnaire || {};
    user.verified = true;
    user.emailVerificationOTP = undefined;
    user.emailVerificationExpires = undefined;
    
    await user.save();

    // Send welcome email
    if (process.env.BREVO_API_KEY) {
      sendWelcomeEmail(user.email, firstName).catch(err => 
        console.log('Welcome email failed:', err)
      );
    }

    // Generate new token
    const token = generateToken(user._id);

    res.json({
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
    console.error('Complete registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during registration completion' 
    });
  }
});

// @route   POST /api/auth/verify-otp-OLD
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

    // Send welcome email (optional)
    if (process.env.BREVO_API_KEY) {
      sendWelcomeEmail(email, user.firstName).catch(err => 
        console.log('Welcome email failed:', err)
      );
    }

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
      console.log(`⚠️ OTP resend requested for unregistered email: ${email}`);
      return res.json({
        success: true,
        message: 'If an account exists with this email, an OTP has been sent.',
        requiresRegistration: true,
        email: email
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
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
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

    // Send email (only if Brevo is configured)
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, user.firstName);
        console.log('✅ OTP email resent successfully to:', email);
      } catch (emailError) {
        console.error('❌ Failed to resend email, but OTP is still valid:', emailError);
      }
    } else {
      console.log('⚠️ BREVO_API_KEY not configured - OTP logged to console only');
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
