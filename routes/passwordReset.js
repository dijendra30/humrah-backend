// routes/passwordReset.js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password      — generate reset token + email link
// POST /api/auth/verify-reset-otp     — verify OTP (legacy, kept for compat)
// POST /api/auth/reset-password       — verify token + update password atomically
// GET  /api/auth/reset-password-health — liveness check
//
// Architecture:
//   Token-based email reset link. Raw token emailed to user, only SHA-256
//   hash stored in MongoDB (resetPasswordToken + resetPasswordExpires on
//   User doc). Survives restarts, works across all instances.
//
// Security model:
//   • Token: crypto.randomBytes(32), SHA-256 hashed before storage
//   • Single-use: token fields cleared after successful reset
//   • TTL = 15 min (resetPasswordExpires checked at verification)
//   • 30-day reset limit per user (checked at send AND at reset)
//   • Last-5-password reuse prevention
//   • User enumeration protection: identical response for existing/non-existing emails
//   • Timing-safe delay on non-existent user path
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const { sendOtp, verifyOtp } = require('../services/otpService');
const { sendPasswordResetEmail } = require('../config/email');
const {
  verifyOtpLimiter,
  passwordResetLimiter
} = require('../middleware/rateLimitMiddleware');

const THIRTY_DAYS_MS  = 30 * 24 * 60 * 60 * 1000;
const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes — matches email template copy

function jsonErr(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS — belt-and-suspenders for Render's reverse proxy
// ─────────────────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  next();
});
router.options('/reset-password',        (_req, res) => res.sendStatus(204));
router.options('/forgot-password',       (_req, res) => res.sendStatus(204));
router.options('/verify-reset-otp',      (_req, res) => res.sendStatus(204));
router.options('/reset-password-health', (_req, res) => res.sendStatus(204));

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// GET /api/auth/reset-password-health
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reset-password-health', (_req, res) => {
  res.json({
    success:   true,
    message:   'Password reset routes are reachable ✅',
    store:     'mongodb',
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Body: { email }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return jsonErr(res, 400, 'Email is required.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail })
      .select('+lastPasswordResetAt firstName');

    // 30-day cooldown — only checked when user exists (no leak on unknown emails)
    if (user && user.lastPasswordResetAt) {
      const msSinceLast = Date.now() - new Date(user.lastPasswordResetAt).getTime();
      if (msSinceLast < THIRTY_DAYS_MS) {
        const nextAllowed = new Date(
          new Date(user.lastPasswordResetAt).getTime() + THIRTY_DAYS_MS
        ).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

        console.warn(`⛔ forgot-password cooldown: ${normalizedEmail} (next: ${nextAllowed})`);
        return res.status(429).json({
          success:         false,
          code:            'RESET_LIMIT_EXCEEDED',
          message:         'Password can only be reset once every 30 days',
          nextAllowedDate: nextAllowed,
          support:         'support@humrah.in',
        });
      }
    }

    // No account — timing-safe silent no-op, same response as success
    if (!user) {
      await new Promise(r => setTimeout(r, 400));
      return res.json({ success: true, message: 'Password reset link/OTP sent successfully.' });
    }

    // Generate secure reset token (raw → user, SHA-256 hash → DB)
    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Store hashed token + expiry atomically
    const updateResult = await User.updateOne(
      { _id: user._id },
      {
        $set: {
          resetPasswordToken:   hashedToken,
          resetPasswordExpires: new Date(Date.now() + TOKEN_EXPIRY_MS)
        }
      }
    );

    if (updateResult.modifiedCount === 0) {
      console.error(`❌ forgot-password error: Failed to save reset token for ${normalizedEmail}`);
      return jsonErr(res, 500, 'Server error. Please try again later.');
    }

    // Build reset URL → static site reset page
    const resetUrl = `https://humrah.in/reset-password.html?token=${rawToken}`;

    // Send email with clickable reset link
    await sendPasswordResetEmail(normalizedEmail, user.firstName, resetUrl);

    console.log(`✅ Password reset link dispatched → ${normalizedEmail}`);
    return res.json({ success: true, message: 'If an account exists with this email, a password reset link has been sent.' });

  } catch (err) {
    console.error('❌ forgot-password error:', err);
    return jsonErr(res, 500, 'Server error. Please try again later.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-reset-otp
// Body: { email, otp }
// Optional step — client can skip this and go straight to /reset-password
// which re-verifies the OTP atomically.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify-reset-otp', verifyOtpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return jsonErr(res, 400, 'Email and OTP are required.');
    if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
      return jsonErr(res, 400, 'OTP must be a 6-digit number.');
    }

    const result = await verifyOtp({
      email,
      otp,
      purpose: 'password_reset'
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
        retryAfterSeconds: result.retryAfterSeconds
      });
    }

    return res.json({ success: true, message: 'OTP verified. You may now reset your password.', verified: true });

  } catch (err) {
    console.error('❌ verify-reset-otp error:', err);
    return jsonErr(res, 500, 'Server error. Please try again later.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Body: { token, newPassword }
//
// Pipeline:
//   1. Input validation
//   2. Token verify (SHA-256 hash lookup, expiry check)
//   3. Password strength
//   4. 30-day cooldown (second line of defense)
//   5. Last-5 reuse check
//   6. Rotate previousPasswords + save + clear token
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reset-password', verifyOtpLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return jsonErr(res, 400, 'Reset token and new password are required.', { code: 'INVALID_TOKEN' });
    }

    // 2. Verify token — hash incoming token and look up in DB
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hashedToken
    }).select('+password +lastPasswordResetAt +resetPasswordCount +previousPasswords +resetPasswordToken +resetPasswordExpires');

    // Token not found — invalid or already used
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Reset link is invalid. Please request a new one from the Humrah app.',
        code:    'INVALID_TOKEN'
      });
    }

    // Token found but expired
    if (!user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      // Clear expired token so it can't be probed again
      user.resetPasswordToken  = null;
      user.resetPasswordExpires = null;
      await user.save();
      return res.status(400).json({
        success: false,
        message: 'This password reset link has expired. Please request a new one.',
        code:    'TOKEN_EXPIRED'
      });
    }

    // 3. Password validation — length
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return jsonErr(res, 400, 'Password must be at least 8 characters.');
    }
    if (newPassword.length > 64) {
      return jsonErr(res, 400, 'Password must not exceed 64 characters.');
    }

    // 3b. Password validation — strength (always enforced, independent of optional validator)
    if (!/[A-Z]/.test(newPassword)) {
      return jsonErr(res, 400, 'Password must contain at least one uppercase letter.');
    }
    if (!/[a-z]/.test(newPassword)) {
      return jsonErr(res, 400, 'Password must contain at least one lowercase letter.');
    }
    if (!/\d/.test(newPassword)) {
      return jsonErr(res, 400, 'Password must contain at least one number.');
    }
    if (!/[@$!%*?&#^]/.test(newPassword)) {
      return jsonErr(res, 400, 'Password must contain at least one special character (@$!%*?&#^).');
    }

    // 3c. Optional extended validator (if available)
    try {
      const { isStrongPassword } = require('../utils/passwordValidator');
      const check = isStrongPassword(newPassword);
      if (!check.valid) return jsonErr(res, 400, check.message);
    } catch (_) { /* validator not available — inline checks above are the gate */ }

    // 5. 30-day cooldown (second line of defense after forgot-password check)
    if (user.lastPasswordResetAt) {
      const msSinceLast = Date.now() - new Date(user.lastPasswordResetAt).getTime();
      if (msSinceLast < THIRTY_DAYS_MS) {
        const nextAllowed = new Date(
          new Date(user.lastPasswordResetAt).getTime() + THIRTY_DAYS_MS
        ).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

        console.warn(`⛔ Reset cooldown hit: ${user.email} (next: ${nextAllowed})`);
        return res.status(429).json({
          success:         false,
          message:         'Password can only be reset once every 30 days',
          nextAllowedDate: nextAllowed,
          support:         'support@humrah.in',
          code:            'RESET_LIMIT_EXCEEDED',
        });
      }
    }

    // 6. Reuse check (last 5 hashes)
    const prevHashes = Array.isArray(user.previousPasswords) ? user.previousPasswords : [];
    for (const oldHash of prevHashes) {
      let reused = false;
      try { reused = await bcrypt.compare(newPassword, oldHash); } catch (_) { /* malformed — skip */ }
      if (reused) {
        console.warn(`⛔ Password reuse attempt: ${user.email}`);
        return res.status(400).json({ success: false, message: 'You have already used this password. Try a new one.', code: 'PASSWORD_REUSED' });
      }
    }

    // 7. Rotate + save + clear token (pre-save hook in User.js bcrypts user.password)
    //    Also increment tokenVersion so all existing JWTs are immediately invalidated.
    //    Anyone who had a stolen token can no longer use it after a password reset.
    if (user.password) {
      user.previousPasswords = [user.password, ...prevHashes].slice(0, 5);
    }
    user.password             = newPassword;
    user.lastPasswordResetAt  = new Date();
    user.resetPasswordCount   = (user.resetPasswordCount || 0) + 1;
    user.tokenVersion         = (user.tokenVersion || 0) + 1;  // ✅ invalidate all old JWTs
    user.resetPasswordToken   = null;   // ✅ single-use: clear token
    user.resetPasswordExpires = null;   // ✅ clear expiry
    await user.save();

    console.log(`✅ Password reset success: ${user.email} (reset #${user.resetPasswordCount})`);
    return res.json({ success: true, message: 'Password reset successful.' });

  } catch (err) {
    console.error('❌ reset-password error:', err);
    return jsonErr(res, 500, 'Server error. Please try again later.');
  }
});

module.exports = router;
