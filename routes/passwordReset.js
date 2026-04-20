// routes/passwordReset.js
// POST /api/auth/forgot-password  — send reset email
// POST /api/auth/reset-password   — set new password with full security checks
// Web page: GET /reset-password   → served by server.js via express.static

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const { sendPasswordResetEmail } = require('../config/email');

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY TOKEN STORE
// Structure: token → { userId, email, issuedAt, expiresAt }
// Tokens expire after TOKEN_TTL_MS (15 minutes by default).
// ─────────────────────────────────────────────────────────────────────────────
const resetTokenStore = new Map();
const TOKEN_TTL_MS    = 15 * 60 * 1000; // 15 minutes

// Prune expired tokens every 30 minutes to keep memory clean
setInterval(() => {
  const now = Date.now();
  for (const [tok, data] of resetTokenStore) {
    if (data.expiresAt < now) resetTokenStore.delete(tok);
  }
}, 30 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always respond with JSON — never expose raw HTML errors.
 * All error responses follow: { success: false, message, code? }
 */
function jsonError(res, status, message, code) {
  const body = { success: false, message };
  if (code) body.code = code;
  return res.status(status).json(body);
}

/**
 * CORS headers applied to every response on this router
 * (belt-and-suspenders alongside the global cors() middleware).
 */
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  next();
});

// Handle OPTIONS preflight for the reset-password endpoint
router.options('/reset-password', (_req, res) => res.sendStatus(204));

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG HEALTH CHECK (remove or protect after confirming deployment works)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reset-password-health', (_req, res) => {
  res.json({
    success:    true,
    message:    'Password reset routes are reachable ✅',
    activeTokens: resetTokenStore.size,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Body: { email: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return jsonError(res, 400, 'Email is required.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Rate-limit: one request per email per 2 minutes ──────────────────────
    for (const [, data] of resetTokenStore) {
      if (
        data.email === normalizedEmail &&
        data.issuedAt > Date.now() - 2 * 60 * 1000
      ) {
        return jsonError(
          res, 429,
          'A reset link was recently sent. Please wait a couple of minutes before trying again.'
        );
      }
    }

    const user = await User.findOne({ email: normalizedEmail }).select('_id firstName email');

    // Always return the same message — prevents email enumeration attacks
    if (!user) {
      await new Promise(r => setTimeout(r, 400));
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = Date.now() + TOKEN_TTL_MS;

    resetTokenStore.set(resetToken, {
      userId:   user._id.toString(),
      email:    normalizedEmail,
      issuedAt: Date.now(),
      expiresAt,
    });

    const baseUrl  = (process.env.APP_BASE_URL || 'https://humrah.in').replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

    await sendPasswordResetEmail(normalizedEmail, user.firstName, resetUrl);
    console.log(`✅ Password reset email sent → ${normalizedEmail}`);

    return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });

  } catch (err) {
    console.error('❌ forgot-password error:', err);
    return jsonError(res, 500, 'Server error. Please try again later.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Body: { token: string, newPassword: string }
//
// Security checks (in order):
//   1. Presence validation — 400 if token or newPassword missing
//   2. Token lookup        — 400 INVALID_TOKEN if not in store
//   3. Token expiry        — 400 TOKEN_EXPIRED  if past 15 min
//   4. Password strength   — 400 if weak
//   5. Load user (with sensitive fields)
//   6. 30-day reset limit  — 429 RESET_LIMIT_EXCEEDED
//   7. Password reuse      — 400 PASSWORD_REUSED (checks last 5 hashes)
//   8. Persist: rotate previousPasswords, hash & save new password
//   9. Invalidate token
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    // ── 1. Presence validation ────────────────────────────────────────────────
    if (!token || !newPassword) {
      return jsonError(res, 400, 'Token and new password are required.');
    }

    console.log(`🔑 Reset attempt — token prefix: ${String(token).substring(0, 8)}…`);

    // ── 2. Token lookup ───────────────────────────────────────────────────────
    const tokenData = resetTokenStore.get(token);
    if (!tokenData) {
      return jsonError(
        res, 400,
        'Invalid or expired reset link. Please request a new one from the Humrah app.',
        'INVALID_TOKEN'
      );
    }

    // ── 3. Token expiry ───────────────────────────────────────────────────────
    if (Date.now() > tokenData.expiresAt) {
      resetTokenStore.delete(token);
      return jsonError(
        res, 400,
        'This reset link has expired. Please request a new one from the Humrah app.',
        'TOKEN_EXPIRED'
      );
    }

    // ── 4. Password strength validation ──────────────────────────────────────
    try {
      const { isStrongPassword } = require('../utils/passwordValidator');
      const check = isStrongPassword(newPassword);
      if (!check.valid) {
        return jsonError(res, 400, check.message);
      }
    } catch (_importErr) {
      // Fallback if validator module is unavailable
      if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return jsonError(res, 400, 'Password must be at least 8 characters.');
      }
    }

    // ── 5. Load user — include all security-sensitive fields ──────────────────
    const user = await User.findById(tokenData.userId)
      .select('+password +lastPasswordResetAt +resetPasswordCount +previousPasswords');

    if (!user) {
      resetTokenStore.delete(token);
      return jsonError(res, 404, 'Account not found. Please contact support@humrah.in');
    }

    // ── 6. Enforce 30-day reset limit ─────────────────────────────────────────
    if (user.lastPasswordResetAt) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (user.lastPasswordResetAt > thirtyDaysAgo) {
        resetTokenStore.delete(token);
        console.warn(`⛔ Reset limit hit for: ${user.email}`);
        return res.status(429).json({
          success: false,
          message:  'Password can only be reset once every 30 days.',
          support:  'support@humrah.in',
          code:     'RESET_LIMIT_EXCEEDED',
        });
      }
    }

    // ── 7. Prevent password reuse (check against last 5 hashes) ──────────────
    const prevHashes = Array.isArray(user.previousPasswords) ? user.previousPasswords : [];
    for (const oldHash of prevHashes) {
      let isReused = false;
      try { isReused = await bcrypt.compare(newPassword, oldHash); } catch (_) { /* skip malformed hash */ }
      if (isReused) {
        resetTokenStore.delete(token);
        console.warn(`⛔ Password reuse attempt for: ${user.email}`);
        return res.status(400).json({
          success: false,
          message: 'You have already used this password. Try a new one.',
          code:    'PASSWORD_REUSED',
        });
      }
    }

    // ── 8. Rotate previousPasswords & save ────────────────────────────────────
    // Push the CURRENT (old) hashed password into history first,
    // then cap the array at 5 entries so we only keep the last 5.
    if (user.password) {
      user.previousPasswords = [user.password, ...prevHashes].slice(0, 5);
    }

    // Assign plain text — the bcrypt pre-save hook hashes it automatically.
    user.password            = newPassword;
    user.lastPasswordResetAt = new Date();
    user.resetPasswordCount  = (user.resetPasswordCount || 0) + 1;

    await user.save();

    // ── 9. Invalidate the token (one-time use) ────────────────────────────────
    resetTokenStore.delete(token);
    console.log(`✅ Password reset success for: ${user.email} (reset #${user.resetPasswordCount})`);

    return res.json({
      success: true,
      message: 'Password reset successful',
    });

  } catch (err) {
    console.error('❌ reset-password error:', err);
    // Never leak internal error details to the client
    return jsonError(res, 500, 'Server error. Please try again later.');
  }
});

module.exports = router;
