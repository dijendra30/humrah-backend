// routes/auth.js - FINAL COMPLETE VERSION (Copy-Paste Ready)
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/auth');

// ==========================================
// RESEND EMAIL CONFIGURATION
// ==========================================
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

let emailServiceReady = false;
let resend;

if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  emailServiceReady = true;
  console.log('✅ Resend email service is ready');
  console.log(`📧 Sending emails from: ${FROM_EMAIL}`);
} else {
  console.log('⚠️ Resend API key not found');
  console.log('💡 Get free API key: https://resend.com/signup');
}

// OTP Storage
const otpStore = new Map();
const OTP_EXPIRY = 10 * 60 * 1000; // 10 minutes

// ==========================================
// JWT TOKEN GENERATION
// ==========================================
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'fallback_secret', {
    expiresIn: '30d'
  });
};

// ==========================================
// ✅ SEND OTP
// ==========================================
router.post('/send-otp', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
], async (req, res) => {
  try {
    console.log('📧 OTP request for:', req.body.email); // DEBUG

    if (!emailServiceReady) {
      return res.status(503).json({
        success: false,
        message: 'Email service not configured'
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { email } = req.body;

    // Check if email exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('❌ Email already registered:', email);
      return res.status(400).json({ 
        success: false, 
        message: 'This email is already registered. Please login instead.' 
      });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    otpStore.set(email, {
      otp,
      expiresAt: Date.now() + OTP_EXPIRY
    });

    // Send email
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [email],
      subject: 'Your Humrah Verification Code',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 50px auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white; }
            .header h1 { margin: 0; font-size: 28px; }
            .content { padding: 40px 30px; text-align: center; }
            .otp-box { background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 20px; margin: 30px 0; }
            .otp-code { font-size: 36px; font-weight: bold; color: #667eea; letter-spacing: 8px; margin: 10px 0; }
            .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Welcome to Humrah!</h1>
            </div>
            <div class="content">
              <h2>Email Verification</h2>
              <p>Thank you for registering with Humrah! Please use the verification code below to complete your registration:</p>
              
              <div class="otp-box">
                <p style="margin: 0; color: #6c757d; font-size: 14px;">Your Verification Code</p>
                <div class="otp-code">${otp}</div>
                <p style="margin: 10px 0 0 0; color: #6c757d; font-size: 12px;">Valid for 10 minutes</p>
              </div>

              <p style="color: #6c757d; font-size: 14px;">If you didn't request this code, please ignore this email.</p>
            </div>
            <div class="footer">
              <p>This is an automated message from Humrah. Please do not reply to this email.</p>
              <p>&copy; ${new Date().getFullYear()} Humrah. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    if (error) {
      console.error('❌ Resend error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to send verification code' 
      });
    }

    console.log(`✅ OTP sent to ${email}: ${otp}`);

    res.json({
      success: true,
      message: 'Verification code sent to your email!'
    });

  } catch (error) {
    console.error('💥 Send OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send verification code' 
    });
  }
});

// ==========================================
// ✅ VERIFY OTP
// ==========================================
router.post('/verify-otp', [
  body('email').isEmail().normalizeEmail(),
  body('otp').isLength({ min: 6, max: 6 })
], async (req, res) => {
  try {
    console.log('🔐 OTP verification for:', req.body.email); // DEBUG

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { email, otp } = req.body;
    const storedData = otpStore.get(email);

    if (!storedData) {
      console.log('❌ No OTP found for:', email);
      return res.status(400).json({ 
        success: false, 
        message: 'No OTP found. Please request a new one.' 
      });
    }

    if (Date.now() > storedData.expiresAt) {
      console.log('❌ OTP expired for:', email);
      otpStore.delete(email);
      return res.status(400).json({ 
        success: false, 
        message: 'OTP expired. Please request a new one.' 
      });
    }

    if (storedData.otp !== otp) {
      console.log('❌ Invalid OTP for:', email);
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid OTP. Please try again.' 
      });
    }

    otpStore.delete(email);
    console.log('✅ OTP verified for:', email);

    res.json({
      success: true,
      verified: true,
      message: 'Email verified successfully!'
    });

  } catch (error) {
    console.error('💥 Verify OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during verification' 
    });
  }
});

// ==========================================
// ✅ EMAIL STATUS CHECK
// ==========================================
router.get('/email-status', (req, res) => {
  res.json({
    success: true,
    emailServiceReady,
    provider: 'Resend',
    fromEmail: FROM_EMAIL,
    message: emailServiceReady 
      ? '✅ Email service is operational' 
      : '❌ Add RESEND_API_KEY to environment'
  });
});

// ==========================================
// ✅ REGISTER (With duplicate check)
// ==========================================
router.post('/register', [
  body('firstName').trim().notEmpty().withMessage('First name required'),
  body('lastName').trim().notEmpty().withMessage('Last name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be 6+ characters')
], async (req, res) => {
  try {
    console.log('📝 Registration attempt:', req.body.email); // DEBUG

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false, 
        errors: errors.array(),
        message: 'Validation failed' 
      });
    }

    const { firstName, lastName, email, password, questionnaire } = req.body;

    // ✅ CHECK DUPLICATE EMAIL
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('❌ Email already exists:', email);
      return res.status(400).json({ 
        success: false, 
        message: 'This email is already registered. Please login instead.' 
      });
    }

    // Create user
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      questionnaire: questionnaire || {}
    });

    await user.save();
    console.log('✅ User registered:', email);

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
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
    console.error('💥 Registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during registration' 
    });
  }
});

// ==========================================
// ✅ LOGIN (With debug logs + welcome message)
// ==========================================
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  try {
    console.log('🔐 Login attempt:', req.body.email); // DEBUG

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false, 
        errors: errors.array(),
        message: 'Invalid email or password format'
      });
    }

    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      console.log('❌ User not found:', email);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }

    console.log('✅ User found:', user.email);

    // Check password
    const isMatch = await user.comparePassword(password);
    console.log('🔑 Password match:', isMatch);

    if (!isMatch) {
      console.log('❌ Wrong password for:', email);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }

    // Update last active
    user.lastActive = Date.now();
    await user.save();

    const token = generateToken(user._id);
    console.log('✅ Login successful:', email);

    // ✅ PERSONALIZED WELCOME MESSAGE
    res.json({
      success: true,
      message: `Welcome back, ${user.firstName}! 🎉`,
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
    console.error('💥 Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during login' 
    });
  }
});

// ==========================================
// ✅ GET CURRENT USER
// ==========================================
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

// ==========================================
// ✅ GOOGLE AUTH
// ==========================================
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
      message: `Welcome back, ${user.firstName}! 🎉`,
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
    console.error('Google auth error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Google authentication failed' 
    });
  }
});

// ==========================================
// ✅ FACEBOOK AUTH
// ==========================================
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
      message: `Welcome back, ${user.firstName}! 🎉`,
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
    console.error('Facebook auth error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Facebook authentication failed' 
    });
  }
});

module.exports = router;
