// middleware/otpValidation.js — Input Validation Middleware for OTP Routes
// ─────────────────────────────────────────────────────────────────────────────
//
// Keeps controllers clean by handling all input validation here.
// Validate → sanitize → normalize before ANY business logic runs.
//
// Why validate here and not in the controller?
//   - Single responsibility: controllers should only call services + map results
//   - Reusable: same validators work across multiple routes
//   - Testable: validate logic isolated from HTTP handling
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_REGEX   = /^\d{6}$/;

function isValidEmail(email) {
  return typeof email === 'string' &&
    EMAIL_REGEX.test(email.trim()) &&
    email.trim().length <= 254;
}

function isValidOtp(otp) {
  return typeof otp === 'string' && OTP_REGEX.test(otp.trim());
}

// ── Middleware: validateSendOtp ───────────────────────────────────────────────
// Used on: POST /send-otp-registration, /send-otp, /send-otp-password-reset
function validateSendOtp(req, res, next) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  }

  // Normalize inline so controllers always get clean input
  req.body.email = email.toLowerCase().trim();

  next();
}

// ── Middleware: validateVerifyOtp ─────────────────────────────────────────────
// Used on: POST /verify-otp-registration, /verify-otp, /verify-otp-password-reset
function validateVerifyOtp(req, res, next) {
  const { email, otp } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  }

  if (!otp) {
    return res.status(400).json({ success: false, message: 'OTP is required.' });
  }

  if (!isValidOtp(otp)) {
    return res.status(400).json({ success: false, message: 'OTP must be exactly 6 digits.' });
  }

  // Normalize inline
  req.body.email = email.toLowerCase().trim();
  req.body.otp   = otp.trim();

  next();
}

module.exports = { validateSendOtp, validateVerifyOtp };
