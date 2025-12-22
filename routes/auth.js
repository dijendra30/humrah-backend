// routes/auth.js - CORRECTED Authentication Routes with OTP-First Registration
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

// ============================================
// NEW REGISTRATION FLOW: OTP-FIRST
// ============================================

// @route   POST /api/auth/register-step1
// @desc    Step 1: Register user details and send OTP (BEFORE questionnaire)
// @access  Public
router.post('/register-step1', [
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

    // Check if user already exists
    let existingUser = await User.findOne({ email });
    
    if (existingUser) {
      // If user exists but not verified, allow re-registration
      if (!existingUser.verified) {
        // Generate new OTP
        const otp = generateOTP();
        existingUser.emailVerificationOTP = otp;
        existingUser.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
        
        // Update user details (in case they changed)
        existingUser.firstName = firstName;
        existingUser.lastName = lastName;
        existingUser.password = password; // Will be hashed by pre-save hook
        
        await existingUser.save();

        // Log OTP
        if (process.env.OTP_TEST_MODE === 'true') {
          console.log('\n' + '='.repeat(60));
          console.log('📧 RE-REGISTRATION - OTP RESENT');
          console.log('='.repeat(60));
          console.log(`📮 Email: ${email}`);
          console.log(`👤 User: ${firstName} ${lastName}`);
          console.log(`🔐 OTP: ${otp}`);
          console.log(`⏰ Expires: ${existingUser.emailVerificationExpires.toLocaleString()}`);
          console.log('='.repeat(60) + '\n');
        }

        // Send OTP email
        if (process.env.BREVO_API_KEY) {
          try {
            await sendOTPEmail(email, otp, firstName);
          } catch (error) {
            console.error('Failed to send OTP email:', error);
          }
        }

        return res.json({
          success: true,
          message: 'OTP sent to your email. Please verify to continue.',
          requiresOTP: true,
          email: email
        });
      } else {
        // User already verified - cannot re-register
        return res.status(400).json({ 
          success: false, 
          message: 'User with this email already exists and is verified. Please login.' 
        });
      }
    }

    // Create NEW user (unverified)
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      verified: false,
      questionnaire: {} // Empty initially
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

    // Send OTP email
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, firstName);
      } catch (error) {
        console.error('Failed to send OTP email:', error);
      }
    }

    res.status(201).json({
      success: true,
      message: 'OTP sent to your email. Please verify to continue registration.',
      requiresOTP: true,
      email: email
    });

  } catch (error) {
    console.error('Registration Step 1 error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during registration' 
    });
  }
});

// @route   POST /api/auth/verify-otp-registration
// @desc    Step 2: Verify OTP for registration (returns token to proceed with questionnaire)
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

    // Mark email as verified but keep OTP for now (will be cleared after questionnaire)
    user.emailVerificationOTP = 'VERIFIED'; // Mark as verified
    user.emailVerificationExpires = undefined;
    await user.save();

    // Generate token for questionnaire step
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'OTP verified! Please complete your profile questionnaire.',
      token,
      requiresQuestionnaire: true, // Frontend should show questionnaire
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email
      }
    });

  } catch (error) {
    console.error('Verify OTP Registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during OTP verification' 
    });
  }
});

// @route   POST /api/auth/complete-registration
// @desc    Step 3: Complete registration with questionnaire (FINAL STEP)
// @access  Private (requires token from OTP verification)
router.post('/complete-registration', auth, async (req, res) => {
  try {
    const { questionnaire } = req.body;

    if (!questionnaire) {
      return res.status(400).json({
        success: false,
        message: 'Questionnaire data is required'
      });
    }

    // Get user
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
        message: 'Please verify your email with OTP first'
      });
    }

    // Process profile photo if provided (base64)
    if (questionnaire.profilePhoto) {
      try {
        // Upload to Cloudinary
        const cloudinary = require('../config/cloudinary');
        const uploadResult = await cloudinary.uploadBase64(
          questionnaire.profilePhoto,
          'humrah/profiles'
        );
        
        // Save Cloudinary URL instead of base64
        user.profilePhoto = uploadResult.url;
        user.profilePhotoPublicId = uploadResult.publicId;
        
        // Remove base64 from questionnaire to save space
        questionnaire.profilePhoto = undefined;
      } catch (error) {
        console.error('Error uploading profile photo:', error);
        // Continue without profile photo - don't block registration
      }
    }

    // Save questionnaire
    user.questionnaire = questionnaire;
    
    // Mark as fully verified
    user.verified = true;
    user.emailVerificationOTP = undefined;
    user.emailVerificationExpires = undefined;
    
    await user.save();

    // Send welcome email
    if (process.env.BREVO_API_KEY) {
      sendWelcomeEmail(user.email, user.firstName).catch(err => 
        console.log('Welcome email failed:', err)
      );
    }

    // Generate new token
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Registration completed successfully! Welcome to Humrah!',
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
    console.error('Complete Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error completing registration'
    });
  }
});

// @route   POST /api/auth/resend-otp-registration
// @desc    Resend OTP during registration
// @access  Public
router.post('/resend-otp-registration', [
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
        message: 'No registration found with this email' 
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
      console.log('📧 OTP RESEND (REGISTRATION)');
      console.log('='.repeat(60));
      console.log(`📮 Email: ${email}`);
      console.log(`👤 User: ${user.firstName} ${user.lastName}`);
      console.log(`🔐 NEW OTP: ${otp}`);
      console.log(`⏰ Expires: ${user.emailVerificationExpires.toLocaleString()}`);
      console.log('='.repeat(60) + '\n');
    }

    // Send OTP email
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, user.firstName);
      } catch (error) {
        console.error('Failed to send OTP email:', error);
      }
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

// ============================================
// LOGIN FLOW (unchanged)
// ============================================

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
