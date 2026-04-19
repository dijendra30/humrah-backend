// routes/passwordReset.js
// POST /api/auth/forgot-password  — send reset email
// POST /api/auth/reset-password   — set new password
// Web page is served by server.js: GET /reset-password → public/reset-password.html

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const User     = require('../models/User');
const { sendPasswordResetEmail } = require('../config/email');

// ── In-memory token store ────────────────────────────────────────────────────
// Format: token → { userId, email, issuedAt, expiresAt }
// NOTE: Replace with Redis for multi-instance / zero-downtime deployments.
const resetTokenStore = new Map();

// Prune expired tokens every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of resetTokenStore) {
    if (data.expiresAt < now) resetTokenStore.delete(token);
  }
}, 30 * 60 * 1000);

// =============================================
// POST /api/auth/forgot-password
// Body: { email }
// =============================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Always 200 — prevents email enumeration attacks
    const user = await User.findOne({ email: normalizedEmail }).select('_id firstName email');
    if (!user) {
      await new Promise(r => setTimeout(r, 400)); // timing-safe delay
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    }

    // Rate-limit: one email per 2 minutes per address
    for (const [, data] of resetTokenStore) {
      if (data.email === normalizedEmail && data.issuedAt > Date.now() - 2 * 60 * 1000) {
        return res.status(429).json({
          success: false,
          message: 'A reset link was recently sent. Please wait a few minutes before trying again.'
        });
      }
    }

    // Generate token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = Date.now() + 15 * 60 * 1000; // 15 minutes

    resetTokenStore.set(resetToken, {
      userId:   user._id.toString(),
      email:    normalizedEmail,
      issuedAt: Date.now(),
      expiresAt
    });

    // ✅ CORRECT URL — clean path, no /public/ prefix
    const baseUrl  = (process.env.APP_BASE_URL || 'https://humrah.in').replace(/\/$/, '');
    const resetUrl = `${baseUrl}/public/reset-password?token=${resetToken}`;

    await sendPasswordResetEmail(normalizedEmail, user.firstName, resetUrl);
    console.log(`✅ Password reset email sent to: ${normalizedEmail}`);

    res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });

  } catch (error) {
    console.error('❌ forgot-password error:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// =============================================
// POST /api/auth/reset-password
// Body: { token, newPassword }
// =============================================
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required' });
    }

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

    // Password strength validation
    try {
      const { isStrongPassword } = require('../utils/passwordValidator');
      const check = isStrongPassword(newPassword);
      if (!check.valid) {
        return res.status(400).json({ success: false, message: check.message });
      }
    } catch (e) {
      // passwordValidator not found — apply basic check
      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
      }
    }

    const user = await User.findById(tokenData.userId).select('+password');
    if (!user) {
      resetTokenStore.delete(token);
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    // Assign — bcrypt hashing done by User model pre-save hook
    user.password = newPassword;
    await user.save();

    // One-time use — delete immediately
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

module.exports = router;
