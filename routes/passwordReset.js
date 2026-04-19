// routes/passwordReset.js
// Forgot Password + Reset Password endpoints for Humrah
// Uses Brevo for email delivery (same as existing OTP flow)

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { sendPasswordResetEmail } = require('../config/email');

// In-memory store (replace with Redis in production for multi-instance deployments)
// Format: { [token]: { userId, email, expiresAt } }
const resetTokenStore = new Map();

// Clean up expired tokens every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of resetTokenStore.entries()) {
    if (data.expiresAt < now) resetTokenStore.delete(token);
  }
}, 30 * 60 * 1000);

// =============================================
// POST /auth/forgot-password
// Body: { email }
// =============================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Always return 200 even if user not found (prevents email enumeration)
    const user = await User.findOne({ email: normalizedEmail }).select('_id firstName email');

    if (!user) {
      // Deliberate delay to prevent timing attacks
      await new Promise(r => setTimeout(r, 400));
      return res.json({
        success: true,
        message: 'If an account exists for that email, a reset link has been sent.'
      });
    }

    // Rate-limit: check if a token was issued in the last 2 minutes for this email
    for (const [, data] of resetTokenStore.entries()) {
      if (
        data.email === normalizedEmail &&
        data.issuedAt > Date.now() - 2 * 60 * 1000
      ) {
        return res.status(429).json({
          success: false,
          message: 'A reset link was recently sent. Please wait a few minutes before trying again.'
        });
      }
    }

    // Generate a secure random token (32 bytes = 64 hex chars)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = Date.now() + 15 * 60 * 1000; // 15 minutes

    // Store in memory
    resetTokenStore.set(resetToken, {
      userId:    user._id.toString(),
      email:     normalizedEmail,
      issuedAt:  Date.now(),
      expiresAt
    });

    // Build reset URL (web page served by the backend)
    const resetUrl = `${process.env.APP_BASE_URL || 'https://humrah.in'}/reset-password?token=${resetToken}`;

    // Send email
    await sendPasswordResetEmail(normalizedEmail, user.firstName, resetUrl);

    console.log(`✅ Password reset email sent to: ${normalizedEmail}`);

    res.json({
      success: true,
      message: 'If an account exists for that email, a reset link has been sent.'
    });

  } catch (error) {
    console.error('❌ forgot-password error:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// =============================================
// POST /auth/reset-password
// Body: { token, newPassword }
// =============================================
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required' });
    }

    // Look up token
    const tokenData = resetTokenStore.get(token);

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset link. Please request a new one.',
        code: 'INVALID_TOKEN'
      });
    }

    if (Date.now() > tokenData.expiresAt) {
      resetTokenStore.delete(token);
      return res.status(400).json({
        success: false,
        message: 'This reset link has expired. Please request a new one.',
        code: 'TOKEN_EXPIRED'
      });
    }

    // Password strength check (reuse existing validator)
    const { isStrongPassword } = require('../utils/passwordValidator');
    const check = isStrongPassword(newPassword);
    if (!check.valid) {
      return res.status(400).json({ success: false, message: check.message });
    }

    // Find user
    const user = await User.findById(tokenData.userId).select('+password');
    if (!user) {
      resetTokenStore.delete(token);
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    // Update password (bcrypt hashing handled by User model pre-save hook)
    user.password = newPassword;
    await user.save();

    // Invalidate the token immediately after use
    resetTokenStore.delete(token);

    console.log(`✅ Password reset successful for: ${user.email}`);

    res.json({
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.'
    });

  } catch (error) {
    console.error('❌ reset-password error:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// =============================================
// GET /reset-password
// Serve the web reset page (HTML)
// =============================================
router.get('/reset-password', (req, res) => {
  // Check token presence (don't validate yet — JS in the page will call the API)
  const { token } = req.query;
  if (!token) {
    return res.redirect('/?error=missing_token');
  }
  // Serve the static HTML page (adjust path to where you place reset-password.html)
  res.sendFile('reset-password.html', { root: __dirname + '/../public' });
});

module.exports = router;
