// routes/auth.js - Authentication Routes with OTP + OAuth
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const User = require('../models/User');
const auth = require('../middleware/auth');
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');

// ===================================================
// HELPERS
// ===================================================
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || 'fallback_secret',
    { expiresIn: '30d' }
  );
};

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// ===================================================
// REGISTER
// ===================================================
router.post('/register', [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { firstName, lastName, email, password, questionnaire } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      questionnaire: questionnaire || {},
      verified: false
    });

    // OTP
    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    // ✅ SEND OTP EMAIL (FIX)
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, firstName);
      } catch (err) {
        console.error('OTP email failed during register:', err);
      }
    }

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      requiresOTP: true,
      token,
      user: {
        id: user._id,
        firstName,
        lastName,
        email,
        verified: user.verified
      }
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false });
  }
});

// ===================================================
// LOGIN
// ===================================================
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

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false });
    }

    if (!user.verified) {
      return res.status(403).json({
        success: false,
        requiresVerification: true,
        email
      });
    }

    user.lastActive = Date.now();
    await user.save();

    const token = generateToken(user._id);
    res.json({ success: true, token, user });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false });
  }
});

// ===================================================
// SEND OTP
// ===================================================
router.post('/send-otp', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ success: false });
    }

    if (user.verified) {
      return res.status(400).json({ success: false });
    }

    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, user.firstName);
      } catch (err) {
        console.error('OTP email failed:', err);
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ success: false });
  }
});

// ===================================================
// VERIFY OTP
// ===================================================
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await User.findOne({ email });

    if (!user || user.verified) {
      return res.status(400).json({ success: false });
    }

    if (
      user.emailVerificationOTP !== otp ||
      new Date() > user.emailVerificationExpires
    ) {
      return res.status(400).json({ success: false });
    }

    user.verified = true;
    user.emailVerificationOTP = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    if (process.env.BREVO_API_KEY) {
      sendWelcomeEmail(email, user.firstName).catch(console.error);
    }

    const token = generateToken(user._id);
    res.json({ success: true, token, user });

  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ success: false });
  }
});

// ===================================================
// RESEND OTP
// ===================================================
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user || user.verified) {
      return res.status(400).json({ success: false });
    }

    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    // ✅ SEND OTP EMAIL (FIX)
    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, user.firstName);
      } catch (err) {
        console.error('OTP resend email failed:', err);
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ success: false });
  }
});

// ===================================================
// ME (PRIVATE)
// ===================================================
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ success: false });
    }
    res.json({ success: true, user });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ success: false });
  }
});

// ===================================================
// GOOGLE AUTH
// ===================================================
router.post('/google', async (req, res) => {
  try {
    const { googleId, email, firstName, lastName, profilePhoto } = req.body;

    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (!user) {
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
    res.json({ success: true, token, user });

  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ success: false });
  }
});

// ===================================================
// FACEBOOK AUTH
// ===================================================
router.post('/facebook', async (req, res) => {
  try {
    const { facebookId, email, firstName, lastName, profilePhoto } = req.body;

    let user = await User.findOne({ $or: [{ facebookId }, { email }] });

    if (!user) {
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
    res.json({ success: true, token, user });

  } catch (err) {
    console.error('Facebook auth error:', err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
