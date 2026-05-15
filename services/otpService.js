// services/otpService.js — Reusable OTP Business Logic (Production-Grade)
// ─────────────────────────────────────────────────────────────────────────────
//
// All OTP operations go through this service so controller and route code
// stays thin. MongoDB is the only state store — no global variables, no Maps,
// no module-level objects. Safe for horizontal scaling on Render.com.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const Otp            = require('../models/Otp');
const { sendOTPEmail } = require('../config/email');

// ── Timing constants (single source of truth) ────────────────────────────────
const OTP_EXPIRY_MS         = 10 * 60 * 1000;   // 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;        // 60 seconds between resends
const OTP_LOCKOUT_MS        = 15 * 60 * 1000;   // 15-minute lockout after 5 fails
const MAX_OTP_ATTEMPTS      = 5;

// ─────────────────────────────────────────────────────────────────────────────
// sendOtp
//
// Generates a secure OTP, hashes it, stores it in MongoDB, and emails it.
// Enforces per-email resend cooldown (DB-backed — survives restarts + scaling).
//
// Returns:
//   { ok: true }                               on success
//   { ok: false, status: <http code>, message } on business-rule failure
//   throws                                      on unexpected error
// ─────────────────────────────────────────────────────────────────────────────
async function sendOtp({ email, purpose, firstName = null, ipAddress = null, userAgent = null }) {
  const normalizedEmail = email.toLowerCase().trim();

  // ── Per-email resend cooldown (DB-backed, cross-instance safe) ────────────
  const recentOtp = await Otp.findOne({
    email:     normalizedEmail,
    purpose,
    createdAt: { $gt: new Date(Date.now() - OTP_RESEND_COOLDOWN_MS) },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (recentOtp) {
    const waitSeconds = Math.ceil(
      (OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(recentOtp.createdAt).getTime())) / 1000
    );
    return {
      ok:                false,
      status:            429,
      message:           `Please wait ${waitSeconds} seconds before requesting a new OTP.`,
      retryAfterSeconds: waitSeconds,
    };
  }

  // ── Invalidate all previous OTPs for this email+purpose ──────────────────
  // Prevents old OTPs from remaining valid after a resend.
  await Otp.deleteMany({ email: normalizedEmail, purpose });

  // ── Generate + hash OTP ───────────────────────────────────────────────────
  const rawOtp  = Otp.generateSecureOtp();                  // CSPRNG, 6 digits
  const otpHash = await Otp.hashOtp(rawOtp);                // bcrypt + pepper, ASYNC ✅

  // ── Persist hashed OTP ────────────────────────────────────────────────────
  await Otp.create({
    email:     normalizedEmail,
    otpHash,                                                 // never plaintext
    purpose,
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
    ipAddress,
    userAgent,
  });

  // ── Send plaintext OTP via email ─────────────────────────────────────────
  // Only the user sees the raw OTP — DB only ever holds the hash.
  try {
    await sendOTPEmail(normalizedEmail, rawOtp, firstName);
  } catch (emailErr) {
    // Log full error server-side (includes Brevo unauthorized IP details)
    console.error('[OTP] Email send failed:', emailErr?.response?.data || emailErr.message);
    // Clean up the saved OTP — it's useless if user never receives it
    await Otp.deleteMany({ email: normalizedEmail, purpose });
    return {
      ok:      false,
      status:  503,
      message: 'Failed to send OTP email. Please try again later.',
    };
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[OTP] ${purpose} OTP sent → ${normalizedEmail} from IP ${ipAddress}`);
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtp
//
// Validates a user-supplied OTP against the stored hash.
// Tracks failed attempts and enforces lockout after MAX_OTP_ATTEMPTS failures.
// Deletes the OTP document on success to prevent replay attacks.
//
// Returns:
//   { ok: true }                               on success
//   { ok: false, status: <http code>, message } on business-rule failure
//   throws                                      on unexpected error
// ─────────────────────────────────────────────────────────────────────────────
async function verifyOtp({ email, otp, purpose }) {
  const normalizedEmail = email.toLowerCase().trim();

  // Generic message — attacker cannot distinguish "not found" vs "expired" vs "wrong".
  const genericFail = {
    ok:      false,
    status:  400,
    message: 'Invalid or expired OTP. Please request a new one.',
  };

  // ── Find valid, unexpired, unused OTP ────────────────────────────────────
  const otpDoc = await Otp.findOne({
    email:     normalizedEmail,
    purpose,
    expiresAt: { $gt: new Date() },
    usedAt:    null,
  }).sort({ createdAt: -1 });

  if (!otpDoc) return genericFail;

  // ── Lockout check ─────────────────────────────────────────────────────────
  if (otpDoc.lockedUntil && new Date() < otpDoc.lockedUntil) {
    const waitSeconds = Math.ceil((otpDoc.lockedUntil.getTime() - Date.now()) / 1000);
    return {
      ok:                false,
      status:            429,
      message:           `Too many failed attempts. Try again in ${waitSeconds} seconds.`,
      retryAfterSeconds: waitSeconds,
    };
  }

  // ── Verify OTP with bcrypt (timing-safe internally) ───────────────────────
  // Otp.verifyOtpHash appends OTP_PEPPER before bcrypt.compare.
  let isValid = false;
  try {
    isValid = await Otp.verifyOtpHash(otp.trim(), otpDoc.otpHash);
  } catch (err) {
    // Pepper missing or bcrypt error — treat as invalid, log server-side.
    console.error('[OTP] verifyOtpHash error:', err.message);
    return genericFail;
  }

  if (!isValid) {
    // ── Increment attempt counter ────────────────────────────────────────
    otpDoc.attempts += 1;

    if (otpDoc.attempts >= MAX_OTP_ATTEMPTS) {
      // ── Lock the document for 15 minutes ────────────────────────────
      otpDoc.lockedUntil = new Date(Date.now() + OTP_LOCKOUT_MS);
      await otpDoc.save();

      console.warn(`[OTP] Lockout triggered for ${normalizedEmail} (purpose: ${purpose})`);

      return {
        ok:      false,
        status:  429,
        message: 'Too many failed attempts. Please request a new OTP after 15 minutes.',
      };
    }

    await otpDoc.save();
    return genericFail;
  }

  // ── OTP is valid — delete document to prevent replay ─────────────────────
  // Using deleteOne (not save with usedAt) ensures the record is gone
  // immediately, closing the race-condition window.
  await Otp.deleteOne({ _id: otpDoc._id });

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[OTP] Verified successfully → ${normalizedEmail} (purpose: ${purpose})`);
  }

  return { ok: true };
}

module.exports = { sendOtp, verifyOtp };
