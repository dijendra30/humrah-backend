// routes/auth.js — Render SAFE (NO SMTP)

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/auth');

// ---------------- SENDGRID SETUP ----------------
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ---------------- OTP STORE ----------------
const otpStore = new Map();
const OTP_EXPIRY = 10 * 60 * 1000;

// ---------------- JWT ----------------
const generateToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });

// ---------------- SEND OTP ----------------
router.post('/send-otp', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email } = req.body;

    if (await User.findOne({ email })) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered'
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    otpStore.set(email, {
      otp,
      expiresAt: Date.now() + OTP_EXPIRY
    });

    await sgMail.send({
      to: email,
      from: process.env.EMAIL_FROM,
      subject: 'Your Humrah Verification Code',
      html: `
        <h2>Your Verification Code</h2>
        <h1 style="letter-spacing:6px">${otp}</h1>
        <p>Valid for 10 minutes</p>
      `
    });

    res.json({ success: true, message: 'OTP sent successfully' });

  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ success: false, message: 'OTP send failed' });
  }
});

// ---------------- VERIFY OTP ----------------
router.post('/verify-otp', [
  body('email').isEmail(),
  body('otp').isLength({ min: 6, max: 6 })
], (req, res) => {
  const { email, otp } = req.body;
  const data = otpStore.get(email);

  if (!data) {
    return res.status(400).json({ success: false, message: 'OTP not found' });
  }

  if (Date.now() > data.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ success: false, message: 'OTP expired' });
  }

  if (data.otp !== otp) {
    return res.status(400).json({ success: false, message: 'Invalid OTP' });
  }

  otpStore.delete(email);
  res.json({ success: true, verified: true });
});

// ---------------- REGISTER ----------------
router.post('/register', [
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  body('emailVerified').isBoolean()
], async (req, res) => {
  try {
    const { firstName, lastName, email, password, emailVerified, questionnaire } = req.body;

    if (!emailVerified) {
      return res.status(400).json({ success: false, message: 'Email not verified' });
    }

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      verified: true,
      questionnaire: questionnaire || {}
    });

    await user.save();
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: { id: user._id, email: user.email }
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// ---------------- LOGIN ----------------
router.post('/login', [
  body('email').isEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user || !(await user.comparePassword(password))) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  const token = generateToken(user._id);
  res.json({ success: true, token, user });
});

// ---------------- ME ----------------
router.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  res.json({ success: true, user });
});

module.exports = router;
