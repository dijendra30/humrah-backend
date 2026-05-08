// controllers/otpController.js — Thin OTP Controllers (Production-Grade)
// ─────────────────────────────────────────────────────────────────────────────
//
// Controllers are deliberately thin. Their only jobs:
//   1. Validate / normalize input
//   2. Call the OTP service
//   3. Map service result → HTTP response
//   Zero business logic lives here.
//
// GENERIC ERROR MESSAGES:
//   All failure cases (NOT_FOUND, EXPIRED, INVALID, ALREADY_USED) return the
//   same 400 response: "Invalid or expired OTP. Please request a new one."
//   An attacker cannot tell which case they hit → prevents oracle attacks and
//   email enumeration via error message differences.
//
// BUGS FIXED OVER PREVIOUS VERSION:
//   ❌ Bug 1: Called Otp.hashOtp() without await → stored Promise object, not hash
//   ❌ Bug 2: Stored field as 'hashedOtp' but model defines 'otpHash' → lookups fail
//   ❌ Bug 3: Used crypto.timingSafeEqual on bcrypt strings → TypeError on mismatch
//   ❌ Bug 4: In-memory global object broke multi-instance deployments on Render
//   All fixed by delegating entirely to otpService.js + Otp.js statics.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { sendOtp, verifyOtp }   = require('../services/otpService');
const { sendOTPEmail }          = require('../config/email');
const User                      = require('../models/User');

// Single source of truth for the generic fail message.
// Used for NOT_FOUND, EXPIRED, INVALID, ALREADY_USED — never distinguish them.
const GENERIC_FAIL_MSG = 'Invalid or expired OTP. Please request a new one.';

// ── Shared input validators ───────────────────────────────────────────────────

function isValidEmail(email) {
  return typeof email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    email.trim().length <= 254;
}

function isValidOtp(otp) {
  return typeof otp === 'string' && /^\d{6}$/.test(otp.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// sendOtpRegistration  —  POST /api/auth/send-otp-registration
//
// Flow: email available → generate OTP → hash → save to DB → email plaintext
// User enumeration protection: same response whether email is taken or not.
// ─────────────────────────────────────────────────────────────────────────────
async function sendOtpRegistration(req, res) {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // User enumeration protection: if email is already registered, don't expose it.
    // Return the same "OTP sent" response regardless — silent no-op.
    const existingUser = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    if (existingUser) {
      // Add a small artificial delay to prevent timing-based enumeration
      await new Promise(r => setTimeout(r, 300));
      return res.json({ success: true, message: 'If this email is available, an OTP has been sent.' });
    }

    const result = await sendOtp(normalizedEmail, 'registration', {
      sendEmailFn: (e, otp) => sendOTPEmail(e, otp),
      ipAddress:   req.ip,
      userAgent:   req.get('user-agent'),
    });

    if (!result.success) {
      return res.status(429).json({
        success:           false,
        message:           `Please wait ${result.cooldownSeconds} seconds before requesting a new OTP.`,
        retryAfterSeconds: result.cooldownSeconds,
      });
    }

    return res.json({ success: true, message: 'If this email is available, an OTP has been sent.' });

  } catch (err) {
    // Never expose internal error details (stack traces, DB errors, etc.) to client
    console.error('[OTPCtrl] sendOtpRegistration error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtpRegistration  —  POST /api/auth/verify-otp-registration
//
// LOCKED is the only case that gets a distinct response (to tell client
// "resend required"). All other failures get the same generic 400.
// ─────────────────────────────────────────────────────────────────────────────
async function verifyOtpRegistration(req, res) {
  try {
    const { email, otp } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    if (!otp || !isValidOtp(otp)) {
      return res.status(400).json({ success: false, message: 'OTP must be exactly 6 digits.' });
    }

    const result = await verifyOtp(email.toLowerCase().trim(), 'registration', otp.trim());

    if (!result.verified) {
      // Only LOCKED gets a distinct message — tells client to request a new OTP
      if (result.reason === 'LOCKED') {
        return res.status(429).json({
          success:           false,
          message:           `Too many failed attempts. Please request a new OTP after ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      // NOT_FOUND, EXPIRED, INVALID, ALREADY_USED → identical generic response
      return res.status(400).json({ success: false, message: GENERIC_FAIL_MSG });
    }

    return res.json({ success: true, message: 'Email verified successfully.', verified: true });

  } catch (err) {
    console.error('[OTPCtrl] verifyOtpRegistration error:', err.message);
    return res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendOtpLogin  —  POST /api/auth/send-otp
//
// If no user account exists, add artificial delay to match real path timing
// then return the same response. Prevents account enumeration.
// ─────────────────────────────────────────────────────────────────────────────
async function sendOtpLogin(req, res) {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const userExists = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    if (!userExists) {
      // Timing delay prevents account enumeration via response time difference
      await new Promise(r => setTimeout(r, 350));
      return res.json({ success: true, message: 'If an account exists, an OTP has been sent.' });
    }

    const result = await sendOtp(normalizedEmail, 'login', {
      sendEmailFn: (e, otp) => sendOTPEmail(e, otp),
      ipAddress:   req.ip,
      userAgent:   req.get('user-agent'),
    });

    if (!result.success) {
      return res.status(429).json({
        success:           false,
        message:           `Please wait ${result.cooldownSeconds} seconds before requesting a new OTP.`,
        retryAfterSeconds: result.cooldownSeconds,
      });
    }

    return res.json({ success: true, message: 'If an account exists, an OTP has been sent.' });

  } catch (err) {
    console.error('[OTPCtrl] sendOtpLogin error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtpLogin  —  POST /api/auth/verify-otp
// ─────────────────────────────────────────────────────────────────────────────
async function verifyOtpLogin(req, res) {
  try {
    const { email, otp } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    if (!otp || !isValidOtp(otp)) {
      return res.status(400).json({ success: false, message: 'OTP must be exactly 6 digits.' });
    }

    const result = await verifyOtp(email.toLowerCase().trim(), 'login', otp.trim());

    if (!result.verified) {
      if (result.reason === 'LOCKED') {
        return res.status(429).json({
          success:           false,
          message:           `Too many failed attempts. Please request a new OTP after ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      return res.status(400).json({ success: false, message: GENERIC_FAIL_MSG });
    }

    return res.json({ success: true, message: 'OTP verified successfully.', verified: true });

  } catch (err) {
    console.error('[OTPCtrl] verifyOtpLogin error:', err.message);
    return res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendOtpPasswordReset  —  POST /api/auth/send-otp-password-reset
// ─────────────────────────────────────────────────────────────────────────────
async function sendOtpPasswordReset(req, res) {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const userExists = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    if (!userExists) {
      await new Promise(r => setTimeout(r, 350));
      return res.json({ success: true, message: 'If an account exists, an OTP has been sent.' });
    }

    const result = await sendOtp(normalizedEmail, 'password_reset', {
      sendEmailFn: (e, otp) => sendOTPEmail(e, otp),
      ipAddress:   req.ip,
      userAgent:   req.get('user-agent'),
    });

    if (!result.success) {
      return res.status(429).json({
        success:           false,
        message:           `Please wait ${result.cooldownSeconds} seconds before requesting a new OTP.`,
        retryAfterSeconds: result.cooldownSeconds,
      });
    }

    return res.json({ success: true, message: 'If an account exists, an OTP has been sent.' });

  } catch (err) {
    console.error('[OTPCtrl] sendOtpPasswordReset error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtpPasswordReset  —  POST /api/auth/verify-otp-password-reset
// ─────────────────────────────────────────────────────────────────────────────
async function verifyOtpPasswordReset(req, res) {
  try {
    const { email, otp } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    if (!otp || !isValidOtp(otp)) {
      return res.status(400).json({ success: false, message: 'OTP must be exactly 6 digits.' });
    }

    const result = await verifyOtp(email.toLowerCase().trim(), 'password_reset', otp.trim());

    if (!result.verified) {
      if (result.reason === 'LOCKED') {
        return res.status(429).json({
          success:           false,
          message:           `Too many failed attempts. Please request a new OTP after ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      return res.status(400).json({ success: false, message: GENERIC_FAIL_MSG });
    }

    return res.json({ success: true, message: 'OTP verified. You may now reset your password.', verified: true });

  } catch (err) {
    console.error('[OTPCtrl] verifyOtpPasswordReset error:', err.message);
    return res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
}

module.exports = {
  sendOtpRegistration,
  verifyOtpRegistration,
  sendOtpLogin,
  verifyOtpLogin,
  sendOtpPasswordReset,
  verifyOtpPasswordReset,
};
