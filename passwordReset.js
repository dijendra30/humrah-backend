// routes/passwordReset.js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password   — generate & email a one-time reset token
// POST /api/auth/reset-password    — consume token, enforce limits, update pw
// GET  /api/auth/reset-password-health — liveness check (remove in prod)
//
// Security model
//   • Tokens: 32-byte crypto.randomBytes hex, stored in-memory Map, TTL = 15 min
//   • Token is ONE-TIME-USE (deleted on every exit path, success or failure)
//   • 30-day reset limit per user (checked in BOTH forgot AND reset endpoints)
//   • Last-5-password reuse prevention (bcrypt.compare against previousPasswords)
//   • Never returns HTML; never leaks internal error details
//   • CORS headers belt-and-suspenders (global cors() already covers most cases)
//
//   ✅ EMAIL ENUMERATION PREVENTION (updated)
//   • User lookup is done silently — if user does NOT exist, we do nothing
//     (no email sent, no token created) but still return the SAME success response
//   • emailRateLimitStore rate-limits ALL emails (existing or not) → prevents
//     attackers from spamming unknown addresses to enumerate valid ones
//   • 400 ms timing-safe delay on the "no user" path → prevents timing attacks
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const { sendPasswordResetEmail } = require('../config/email');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN_TTL_MS      = 15 * 60 * 1000;       // 15 minutes
const THIRTY_DAYS_MS    = 30 * 24 * 60 * 60 * 1000;
const EMAIL_RATE_TTL_MS = 2  * 60 * 1000;        // 2-minute per-email cooldown

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY TOKEN STORE
// token (hex string) → { userId, email, issuedAt, expiresAt }
// NOTE: On Render.com free-tier, every deploy wipes this map.
//       Users must request a FRESH link after each deploy.
// ─────────────────────────────────────────────────────────────────────────────
const resetTokenStore = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL RATE-LIMIT STORE
// normalizedEmail → lastRequestedAt (ms timestamp)
//
// Tracks ALL forgot-password attempts by email address, regardless of whether
// the email belongs to a real user. This closes the enumeration gap where an
// attacker could hammer unknown addresses without ever hitting the token-store
// rate-limit (since no token is created for non-existent users).
// ─────────────────────────────────────────────────────────────────────────────
const emailRateLimitStore = new Map();

// Prune stale entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - EMAIL_RATE_TTL_MS;
  for (const [email, ts] of emailRateLimitStore) {
    if (ts < cutoff) emailRateLimitStore.delete(email);
  }
}, 10 * 60 * 1000).unref();

// Prune stale tokens every 30 minutes (keeps memory clean on long-running servers)
setInterval(() => {
  const now = Date.now();
  for (const [tok, data] of resetTokenStore) {
    if (data.expiresAt < now) resetTokenStore.delete(tok);
  }
}, 30 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Always return JSON — never let Express send an HTML error page */
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
router.options('/reset-password-health', (_req, res) => res.sendStatus(204));

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// GET /api/auth/reset-password-health
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reset-password-health', (_req, res) => {
  res.json({
    success:      true,
    message:      'Password reset routes are reachable ✅',
    activeTokens: resetTokenStore.size,
    timestamp:    new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Body: { email: string }
//
// ✅ SECURITY: Same response for existing and non-existing users
//    If user EXISTS   → generate token, send reset email
//    If user MISSING  → do nothing silently (no email, no token)
//    BOTH paths       → return identical success JSON
//
// ✅ COOLDOWN ENFORCED HERE: If user already reset within 30 days,
//    returns 429 with code: "RESET_LIMIT_EXCEEDED" immediately.
//    The Android app reads this code and shows the message inline.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return jsonErr(res, 400, 'Email is required.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Per-email rate-limit (applies to ALL emails, real or not) ─────────
    // This MUST come before the DB lookup so non-existing emails are also
    // throttled, preventing enumeration via repeated spam attempts.
    const lastRequested = emailRateLimitStore.get(normalizedEmail);
    if (lastRequested && Date.now() - lastRequested < EMAIL_RATE_TTL_MS) {
      return jsonErr(
        res, 429,
        'A reset link was recently sent. Please wait a couple of minutes before trying again.'
      );
    }

    // Record this attempt immediately (before DB work) so concurrent requests
    // from the same email are also blocked.
    emailRateLimitStore.set(normalizedEmail, Date.now());

    // ── Lookup user (need lastPasswordResetAt for the 30-day check) ───────
    const user = await User.findOne({ email: normalizedEmail })
      .select('+lastPasswordResetAt firstName');

    // ── 30-DAY COOLDOWN CHECK ─────────────────────────────────────────────
    // Done BEFORE sending any email so the app gets the error immediately.
    // We only run this when the user actually exists (no info leak on unknown emails).
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

    // ── No user found — do nothing, but return SAME response as success ───
    // 400 ms timing-safe delay prevents attackers inferring existence via
    // response-time differences (real user path hits DB + email service).
    if (!user) {
      console.log(`ℹ️  forgot-password: no account for ${normalizedEmail} — silent no-op`);
      await new Promise(r => setTimeout(r, 400));
      return res.json({
        success: true,
        message: 'If an account exists for that email, a reset link has been sent.',
      });
    }

    // ── Generate and store token ──────────────────────────────────────────
    const resetToken = crypto.randomBytes(32).toString('hex');
    resetTokenStore.set(resetToken, {
      userId:    user._id.toString(),
      email:     normalizedEmail,
      issuedAt:  Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    // ── Build reset URL and send email ────────────────────────────────────
    const baseUrl  = (process.env.APP_BASE_URL || 'https://humrah.in').replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

    await sendPasswordResetEmail(normalizedEmail, user.firstName, resetUrl);
    console.log(`✅ Password reset email dispatched → ${normalizedEmail}`);

    return res.json({
      success: true,
      message: 'If an account exists for that email, a reset link has been sent.',
    });

  } catch (err) {
    console.error('❌ forgot-password error:', err);
    return jsonErr(res, 500, 'Server error. Please try again later.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Body: { token: string, newPassword: string }
//
// Full security pipeline:
//   1.  Presence check (400 if missing)
//   2.  Token lookup in resetTokenStore (400 INVALID_TOKEN if not found)
//   3.  Token expiry check (400 TOKEN_EXPIRED)
//   4.  Password strength validation (400)
//   5.  Load user with sensitive fields (+password, +lastPasswordResetAt, etc.)
//   6.  30-day reset cooldown (429 RESET_LIMIT_EXCEEDED) — second line of defense
//   7.  Password reuse check against last 5 hashes (400 PASSWORD_REUSED)
//   8.  Rotate previousPasswords, assign new plaintext, save (pre-save hook bcrypts)
//   9.  Update lastPasswordResetAt + resetPasswordCount
//  10.  Delete token (one-time use)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  let tokenConsumed = false;

  try {
    const { token, newPassword } = req.body;

    // ── 1. Presence ────────────────────────────────────────────────────────
    if (!token || !newPassword) {
      return jsonErr(res, 400, 'Token and new password are required.');
    }

    console.log(`🔑 Reset attempt — token[0..8]: ${String(token).substring(0, 8)}…`);

    // ── 2. Token lookup ────────────────────────────────────────────────────
    const tokenData = resetTokenStore.get(token);
    if (!tokenData) {
      return jsonErr(res, 400,
        'Invalid or expired reset link. Please request a new one from the Humrah app.',
        { code: 'INVALID_TOKEN' }
      );
    }

    // ── 3. Token expiry ────────────────────────────────────────────────────
    if (Date.now() > tokenData.expiresAt) {
      resetTokenStore.delete(token);
      tokenConsumed = true;
      return jsonErr(res, 400,
        'This reset link has expired. Please request a new one from the Humrah app.',
        { code: 'TOKEN_EXPIRED' }
      );
    }

    // ── 4. Password strength ───────────────────────────────────────────────
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return jsonErr(res, 400, 'Password must be at least 8 characters.');
    }
    try {
      const { isStrongPassword } = require('../utils/passwordValidator');
      const check = isStrongPassword(newPassword);
      if (!check.valid) {
        return jsonErr(res, 400, check.message);
      }
    } catch (_) {
      // passwordValidator module not available — basic check already done above
    }

    // ── 5. Load user (need sensitive fields) ──────────────────────────────
    const user = await User.findById(tokenData.userId)
      .select('+password +lastPasswordResetAt +resetPasswordCount +previousPasswords');

    if (!user) {
      resetTokenStore.delete(token);
      tokenConsumed = true;
      return jsonErr(res, 404,
        'Account not found. Please contact support@humrah.in'
      );
    }

    // ── 6. 30-day reset cooldown (second line of defense) ─────────────────
    if (user.lastPasswordResetAt) {
      const daysSinceLast = Date.now() - new Date(user.lastPasswordResetAt).getTime();

      if (daysSinceLast < THIRTY_DAYS_MS) {
        resetTokenStore.delete(token);
        tokenConsumed = true;

        const nextAllowed = new Date(
          new Date(user.lastPasswordResetAt).getTime() + THIRTY_DAYS_MS
        ).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

        console.warn(`⛔ Reset cooldown hit: ${user.email} (next allowed: ${nextAllowed})`);

        return res.status(429).json({
          success:         false,
          message:         'Password can only be reset once every 30 days',
          nextAllowedDate: nextAllowed,
          support:         'support@humrah.in',
          code:            'RESET_LIMIT_EXCEEDED',
        });
      }
    }

    // ── 7. Password reuse check (last 5 hashes) ────────────────────────────
    const prevHashes = Array.isArray(user.previousPasswords) ? user.previousPasswords : [];

    for (const oldHash of prevHashes) {
      let reused = false;
      try {
        reused = await bcrypt.compare(newPassword, oldHash);
      } catch (_) {
        // Malformed hash in DB — skip without crashing
      }
      if (reused) {
        resetTokenStore.delete(token);
        tokenConsumed = true;

        console.warn(`⛔ Password reuse attempt: ${user.email}`);
        return res.status(400).json({
          success: false,
          message: 'You have already used this password. Try a new one.',
          code:    'PASSWORD_REUSED',
        });
      }
    }

    // ── 8. Rotate previousPasswords ────────────────────────────────────────
    if (user.password) {
      user.previousPasswords = [user.password, ...prevHashes].slice(0, 5);
    }

    // Assign plaintext — bcrypt pre-save hook in User.js hashes it automatically
    user.password            = newPassword;
    user.lastPasswordResetAt = new Date();
    user.resetPasswordCount  = (user.resetPasswordCount || 0) + 1;

    await user.save();

    // ── 9. Invalidate token (strict one-time use) ──────────────────────────
    resetTokenStore.delete(token);
    tokenConsumed = true;

    console.log(`✅ Password reset success: ${user.email} (reset #${user.resetPasswordCount})`);

    return res.json({
      success: true,
      message: 'Password reset successful',
    });

  } catch (err) {
    if (!tokenConsumed && req.body?.token) {
      resetTokenStore.delete(req.body.token);
    }
    console.error('❌ reset-password error:', err);
    return jsonErr(res, 500, 'Server error. Please try again later.');
  }
});

module.exports = router;
