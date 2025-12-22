// routes/auth.js - Authentication Routes with OTP
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { sendOTPEmail, sendWelcomeEmail } = require('../config/email');

// ==========================
// HELPERS
// ==========================
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

// ==========================
// REGISTER
// ==========================
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
      return res.status(400).json({ success: false });
    }

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      questionnaire: questionnaire || {},
      verified: false
    });

    const otp = generateOTP();
    user.emailVerificationOTP = otp;
    user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    if (process.env.BREVO_API_KEY) {
      try {
        await sendOTPEmail(email, otp, firstName);
      } catch (e) {
        console.error('OTP email failed:', e);
      }
    }

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      requiresOTP: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        verified: false
      }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false });
  }
});

// ==========================
// LOGIN
// ==========================
router.post('/login', async (req, res) => {
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

  const token = generateToken(user._id);
  res.json({ success: true, token, user });
});

// ==========================
// SEND OTP
// ==========================
router.post('/send-otp', async (req, res) => {
  const { email } = req.body;

  let user = await User.findOne({ email });

  if (!user) {
    user = new User({
      firstName: 'Temp',
      lastName: 'User',
      email,
      password: Math.random().toString(36).slice(-12),
      verified: false
    });
  }

  if (user.verified && user.firstName !== 'Temp') {
    return res.status(400).json({ success: false });
  }

  const otp = generateOTP();
  user.emailVerificationOTP = otp;
  user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  if (process.env.BREVO_API_KEY) {
    try {
      await sendOTPEmail(email, otp, user.firstName === 'Temp' ? 'User' : user.firstName);
    } catch (e) {
      console.error(e);
    }
  }

  res.json({ success: true });
});

// ==========================
// VERIFY OTP (ONLY ONE — FIXED)
// ==========================
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  const enteredOtp = otp.toString().trim();

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ success: false });
  }

  if (!user.emailVerificationOTP) {
    return res.status(400).json({ success: false });
  }

  if (new Date() > user.emailVerificationExpires) {
    return res.status(400).json({ success: false });
  }

  if (user.emailVerificationOTP !== enteredOtp) {
    return res.status(400).json({ success: false });
  }

  const isTemp = user.firstName === 'Temp';

  if (isTemp) {
    user.emailVerificationOTP = 'VERIFIED';
    await user.save();

    const token = generateToken(user._id);
    return res.json({
      success: true,
      requiresRegistration: true,
      token
    });
  }

  user.verified = true;
  user.emailVerificationOTP = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  if (process.env.BREVO_API_KEY) {
    sendWelcomeEmail(email, user.firstName).catch(() => {});
  }

  const token = generateToken(user._id);
  res.json({ success: true, token, user });
});

// ==========================
// COMPLETE REGISTRATION
// ==========================
router.post('/complete-registration', auth, async (req, res) => {
  const { firstName, lastName, password, questionnaire } = req.body;

  const user = await User.findById(req.userId);
  if (!user || user.emailVerificationOTP !== 'VERIFIED') {
    return res.status(400).json({ success: false });
  }

  user.firstName = firstName;
  user.lastName = lastName;
  user.password = password;
  user.questionnaire = questionnaire || {};
  user.verified = true;
  user.emailVerificationOTP = undefined;
  user.emailVerificationExpires = undefined;

  await user.save();

  const token = generateToken(user._id);
  res.json({ success: true, token, user });
});

// ==========================
// RESEND OTP
// ==========================
router.post('/resend-otp', async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  if (!user || user.verified) {
    return res.status(400).json({ success: false });
  }

  const otp = generateOTP();
  user.emailVerificationOTP = otp;
  user.emailVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  if (process.env.BREVO_API_KEY) {
    try {
      await sendOTPEmail(email, otp, user.firstName);
    } catch (e) {
      console.error(e);
    }
  }

  res.json({ success: true });
});

// ==========================
// ME
// ==========================
router.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  if (!user) return res.status(404).json({ success: false });
  res.json({ success: true, user });
});

// ==========================
// GOOGLE AUTH
// ==========================
router.post('/google', async (req, res) => {
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

  const token = generateToken(user._id);
  res.json({ success: true, token, user });
});

// ==========================
// FACEBOOK AUTH
// ==========================
router.post('/facebook', async (req, res) => {
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

  const token = generateToken(user._id);
  res.json({ success: true, token, user });
});

module.exports = router;
