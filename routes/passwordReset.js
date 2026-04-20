// routes/passwordReset.js
// POST /api/auth/forgot-password  — send reset email
// POST /api/auth/reset-password   — set new password
// Web page: GET /reset-password → served by server.js via express.static

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const User     = require('../models/User');
const { sendPasswordResetEmail } = require('../config/email');

// ── In-memory token store ────────────────────────────────────────────────────
// token → { userId, email, issuedAt, expiresAt }
const resetTokenStore = new Map();

// Prune expired tokens every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of resetTokenStore) {
    if (data.expiresAt < now) resetTokenStore.delete(token);
  }
}, 30 * 60 * 1000);

// ── Debug endpoint — confirms the route is reachable (remove after testing) ──
router.get('/reset-password-health', (req, res) => {
  res.json({
    success: true,
    message: 'Password reset routes are reachable ✅',
    tokens: resetTokenStore.size
  });
});

// =============================================
// POST /api/auth/forgot-password
// =============================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).select('_id firstName email');

    if (!user) {
      await new Promise(r => setTimeout(r, 400));
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    }

    // Rate-limit per email: one request per 2 minutes
    for (const [, data] of resetTokenStore) {
      if (data.email === normalizedEmail && data.issuedAt > Date.now() - 2 * 60 * 1000) {
        return res.status(429).json({
          success: false,
          message: 'A reset link was recently sent. Please wait a few minutes before trying again.'
        });
      }
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = Date.now() + 15 * 60 * 1000; // 15 minutes

    resetTokenStore.set(resetToken, {
      userId:   user._id.toString(),
      email:    normalizedEmail,
      issuedAt: Date.now(),
      expiresAt
    });

    const baseUrl  = (process.env.APP_BASE_URL || 'https://humrah.in').replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

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
// =============================================
router.post('/reset-password', async (req, res) => {
  // Explicit CORS headers for this endpoint
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');

  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required' });
    }

    console.log(`🔑 Reset attempt — token prefix: ${token.substring(0, 8)}…`);

    // ── 1. Validate token ────────────────────────────────────────────────────
    const tokenData = resetTokenStore.get(token);
    console.log(`🔑 Token found in store: ${!!tokenData}`);

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

    // ── 2. Password strength validation ─────────────────────────────────────
    try {
      const { isStrongPassword } = require('../utils/passwordValidator');
      const check = isStrongPassword(newPassword);
      if (!check.valid) {
        return res.status(400).json({ success: false, message: check.message });
      }
    } catch (e) {
      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
      }
    }

    // ── 3. Load user (include sensitive reset fields) ────────────────────────
    const user = await User.findById(tokenData.userId)
      .select('+password +lastPasswordResetAt +resetPasswordCount +previousPasswords');

    if (!user) {
      resetTokenStore.delete(token);
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    // ── 4. Enforce 30-day reset limit ────────────────────────────────────────
    if (user.lastPasswordResetAt) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (user.lastPasswordResetAt > thirtyDaysAgo) {
        resetTokenStore.delete(token);
        console.log(`⛔ Password reset limit exceeded for: ${user.email}`);
        return res.status(429).json({
          success: false,
          message: 'You can only reset your password once every 30 days. If you need urgent help, contact support@humrah.in',
          code: 'RESET_LIMIT_EXCEEDED'
        });
      }
    }

    // ── 5. Check password reuse (last 5 passwords) ───────────────────────────
    if (user.previousPasswords && user.previousPasswords.length > 0) {
      for (const oldHash of user.previousPasswords) {
        const isReused = await bcrypt.compare(newPassword, oldHash);
        if (isReused) {
          resetTokenStore.delete(token);
          console.log(`⛔ Password reuse attempt for: ${user.email}`);
          return res.status(400).json({
            success: false,
            message: 'This password was used recently. Please choose a different one.',
            code: 'PASSWORD_REUSED'
          });
        }
      }
    }

    // ── 6. Save old password hash to history (keep last 5) ──────────────────
    if (user.password) {
      user.previousPasswords = [user.password, ...(user.previousPasswords || [])].slice(0, 5);
    }

    // ── 7. Set new password + update tracking fields ─────────────────────────
    // NOTE: user.save() triggers the bcrypt pre-save hook automatically
    user.password            = newPassword;
    user.lastPasswordResetAt = new Date();
    user.resetPasswordCount  = (user.resetPasswordCount || 0) + 1;

    await user.save();

    // ── 8. Invalidate token ──────────────────────────────────────────────────
    resetTokenStore.delete(token);
    console.log(`✅ Password reset successful for: ${user.email} (reset #${user.resetPasswordCount})`);

    res.json({
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.'
    });
  } catch (error) {
    console.error('❌ reset-password error:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// Handle OPTIONS preflight explicitly
router.options('/reset-password', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.sendStatus(204);
});

module.exports = router;
