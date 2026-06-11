const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const AdminOtp = require('../models/AdminOtp');
const User = require('../models/User');
const { Resend } = require('resend');

// Provide a dummy key if RESEND_API_KEY is missing so it doesn't crash, 
// though emails will fail if it's missing. The console.log still works.
const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy');

const ADMIN_EMAIL = 'safety@humrah.in'; // Official admin destination email

const otpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Increased for testing
  message: { success: false, message: 'Too many OTP requests. Please try again after 15 minutes.' }
});

router.post('/otp/send', otpRateLimiter, async (req, res) => {
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins
    
    console.log('\n==================================');
    console.log('🛡️ ADMIN DASHBOARD OTP IS:', otp);
    console.log('==================================\n');

    // Clear old OTPs for this email
    await AdminOtp.deleteMany({ email: ADMIN_EMAIL });

    const newOtp = new AdminOtp({
      email: ADMIN_EMAIL,
      otpHash,
      expiresAt
    });
    await newOtp.save();

    try {
      const { data, error: resendError } = await resend.emails.send({
        from: 'Humrah Admin <safety@system.humrah.in>', // Using verified domain
        to: ADMIN_EMAIL,
        subject: 'Humrah Admin Dashboard Login OTP',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>Humrah Admin Dashboard Login</h2>
            <p>Your One-Time Password (OTP) for admin access is:</p>
            <h1 style="color: #4f46e5; letter-spacing: 5px;">${otp}</h1>
            <p>This OTP is valid for 5 minutes. Do not share it with anyone.</p>
          </div>
        `
      });

      if (resendError) {
        console.error('⚠️ Resend API rejected the email:', resendError);
      } else {
        console.log('✅ Resend email dispatch successful. ID:', data?.id);
      }
    } catch (emailErr) {
      console.error('⚠️ Resend network/code error:', emailErr.message);
    }

    res.json({ success: true, message: 'OTP generated successfully.' });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, message: 'Failed to send OTP.' });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ success: false, message: 'OTP is required.' });

    const adminOtp = await AdminOtp.findOne({ email: ADMIN_EMAIL });
    if (!adminOtp) return res.status(400).json({ success: false, message: 'OTP expired or not requested.' });

    adminOtp.attempts += 1;
    if (adminOtp.attempts > 5) {
      await AdminOtp.deleteOne({ _id: adminOtp._id });
      return res.status(400).json({ success: false, message: 'Maximum attempts reached. Request a new OTP.' });
    }
    await adminOtp.save();

    const isMatch = await bcrypt.compare(otp, adminOtp.otpHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    await AdminOtp.deleteOne({ _id: adminOtp._id });

    // Find or create the admin user
    let user = await User.findOne({ email: ADMIN_EMAIL });
    if (!user) {
      user = new User({
        firstName: 'Humrah',
        lastName: 'Support',
        email: ADMIN_EMAIL,
        password: Math.random().toString(36).slice(-10) + 'A1!', // Dummy password to pass validation
        role: 'SUPER_ADMIN',
        emailVerified: true,
        verified: true,
        status: 'ACTIVE'
      });
      await user.save();
    } else {
      // Ensure they have correct role
      if (user.role !== 'SUPER_ADMIN') {
        user.role = 'SUPER_ADMIN';
        await user.save();
      }
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    const token = jwt.sign(
      { userId: user._id, role: user.role, tv: user.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        _id: user._id,
        email: user.email,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, message: 'Failed to verify OTP.' });
  }
});

module.exports = router;
