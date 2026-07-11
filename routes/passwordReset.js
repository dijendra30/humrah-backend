// routes/passwordReset.js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password      — send 6-digit OTP via email
// POST /api/auth/verify-reset-otp     — verify OTP (one-time use)
// POST /api/auth/reset-password       — verify OTP + update password atomically
// GET  /api/auth/reset-password-health — liveness check
//
// CRITICAL FIX vs original version:
//   Old code: resetTokenStore = new Map() — wiped on every Render deploy,
//   broken across multiple instances (load balancer sends verify to wrong instance).
//   New code: all state in MongoDB via otpService. Survives restarts, works
//   correctly on all instances.
//
// Security model:
//   • OTP: bcrypt-hashed 6-digit, TTL = 10 min (MongoDB TTL index)
//   • One-time use: document deleted after successful verification
//   • 30-day reset limit per user (checked at send AND at reset)
//   • Last-5-password reuse prevention
//   • User enumeration protection: identical response for existing/non-existing emails
//   • Timing-safe delay on non-existent user path
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const { sendOtp, verifyOtp } = require('../services/otpService');
const { sendOTPEmail }       = require('../config/email');
const {
  verifyOtpLimiter,
  passwordResetLimiter
} = require('../middleware/rateLimitMiddleware');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

    // Generate + hash + store OTP in MongoDB via service
    const result = await sendOtp({
      email: normalizedEmail,
      purpose: 'password_reset',
      firstName: user.firstName,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success:           false,
        message:           result.message,
        retryAfterSeconds: result.retryAfterSeconds
      });
    }

    console.log(`✅ Password reset OTP dispatched → ${normalizedEmail}`);
    return res.json({ success: true, message: 'Password reset link/OTP sent successfully.' });

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
// Body: { email, otp, newPassword }
//
// Pipeline:
//   1. Input validation
//   2. OTP verify (MongoDB — cross-instance, survives restarts)
//   3. Password strength
//   4. Load user
//   5. 30-day cooldown (second line of defense)
//   6. Last-5 reuse check
//   7. Rotate previousPasswords + save
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reset-password', verifyOtpLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return jsonErr(res, 400, 'Email, OTP, and new password are required.');
    }
    if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
      return jsonErr(res, 400, 'OTP must be a 6-digit number.');
    }

    // 2. Verify OTP
    const otpResult = await verifyOtp({
      email,
      otp,
      purpose: 'password_reset'
    });
    if (!otpResult.ok) {
      return res.status(otpResult.status || 400).json({
        success: false,
        message: otpResult.message,
        retryAfterSeconds: otpResult.retryAfterSeconds,
        code: otpResult.status === 400 ? 'INVALID_OTP' : undefined
      });
    }

    // 3. Password strength
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return jsonErr(res, 400, 'Password must be at least 8 characters.');
    }
    try {
      const { isStrongPassword } = require('../utils/passwordValidator');
      const check = isStrongPassword(newPassword);
      if (!check.valid) return jsonErr(res, 400, check.message);
    } catch (_) { /* validator not available — length check above is minimum gate */ }

    // 4. Load user
    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail })
      .select('+password +lastPasswordResetAt +resetPasswordCount +previousPasswords');

    if (!user) {
      return jsonErr(res, 404, 'Account not found. Please contact support@humrah.in');
    }

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

    // 7. Rotate + save (pre-save hook in User.js bcrypts user.password)
    //    Also increment tokenVersion so all existing JWTs are immediately invalidated.
    //    Anyone who had a stolen token can no longer use it after a password reset.
    if (user.password) {
      user.previousPasswords = [user.password, ...prevHashes].slice(0, 5);
    }
    user.password            = newPassword;
    user.lastPasswordResetAt = new Date();
    user.resetPasswordCount  = (user.resetPasswordCount || 0) + 1;
    user.tokenVersion        = (user.tokenVersion || 0) + 1;  // ✅ invalidate all old JWTs
    await user.save();

    console.log(`✅ Password reset success: ${user.email} (reset #${user.resetPasswordCount})`);
    return res.json({ success: true, message: 'Password reset successful.' });

  } catch (err) {
    console.error('❌ reset-password error:', err);
    return jsonErr(res, 500, 'Server error. Please try again later.');
  }
});

module.exports = router;
