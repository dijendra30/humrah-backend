// services/otpService.js — Reusable OTP Business Logic (Production-Grade)
// ─────────────────────────────────────────────────────────────────────────────
//
// ✅ HORIZONTAL SCALING / MULTI-INSTANCE SAFETY:
//   This service is 100% stateless — zero in-memory state.
//   Every operation reads from and writes to MongoDB.
//   Whether a request hits Render instance A, B, or C, the result is identical
//   because all instances share the same MongoDB cluster.
//
//   Global JS objects (Map, object literals) are process-local — they live in
//   the Node.js heap of ONE instance and are invisible to all others.
//   That's why: Instance A stores OTP → request hits Instance B → lookup fails.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const Otp = require('../models/Otp');

// ── Constants ─────────────────────────────────────────────────────────────────
const OTP_EXPIRY_MS          = 10 * 60 * 1000; // 10 min — short window limits brute-force surface
const OTP_LOCKOUT_MS         = 15 * 60 * 1000; // 15 min lockout after maxAttempts failures
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;       // 60s minimum between sends (DB-level, cross-instance)

// ─────────────────────────────────────────────────────────────────────────────
// sendOtp(email, purpose, options)
//
// Generates a cryptographically secure OTP, hashes it, persists the hash,
// sends the plaintext via email. The DB NEVER sees the plaintext OTP.
//
// Returns:
//   { success: true }
//   { success: false, cooldownSeconds: N }   — resend cooldown active
//
// Throws on unexpected DB or email errors (caller should catch).
// ─────────────────────────────────────────────────────────────────────────────
async function sendOtp(email, purpose, { sendEmailFn, ipAddress = null, userAgent = null } = {}) {
  const normalizedEmail = email.toLowerCase().trim();

  // ── DB-level resend cooldown ──────────────────────────────────────────────
  // express-rate-limit operates per-IP in process memory.
  // An attacker rotating IPs or hitting different Render instances bypasses it.
  // This check is per-email in MongoDB — shared across ALL instances.
  const recentOtp = await Otp.findOne({
    email:     normalizedEmail,
    purpose,
    createdAt: { $gt: new Date(Date.now() - OTP_RESEND_COOLDOWN_MS) },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (recentOtp) {
    const elapsedMs = Date.now() - new Date(recentOtp.createdAt).getTime();
    const waitMs    = OTP_RESEND_COOLDOWN_MS - elapsedMs;
    return { success: false, cooldownSeconds: Math.ceil(waitMs / 1000) };
  }

  // ── Invalidate ALL previous OTPs for this email+purpose ──────────────────
  // Prevents using a previously valid OTP after requesting a new one.
  // (Replay attack prevention + ensures only one active OTP per flow.)
  await Otp.deleteMany({ email: normalizedEmail, purpose });

  // ── Generate, hash, persist ───────────────────────────────────────────────
  const rawOtp  = Otp.generateSecureOtp();            // CSPRNG — NOT Math.random()
  const otpHash = await Otp.hashOtp(rawOtp);           // bcrypt+pepper — MUST await

  await Otp.create({
    email:     normalizedEmail,
    otpHash,                                           // ✅ correct field name (not hashedOtp)
    purpose,
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
    ipAddress,
    userAgent,
  });

  // ── Send plaintext OTP via email — only the hash is stored in DB ─────────
  if (typeof sendEmailFn === 'function') {
    await sendEmailFn(normalizedEmail, rawOtp);
  }

  // Only log in non-production environments to avoid leaking email addresses in logs
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[OTPService] OTP sent | email=${normalizedEmail} | purpose=${purpose} | ip=${ipAddress}`);
  }

  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtp(email, purpose, submittedOtp)
//
// Returns one of:
//   { verified: true }
//   { verified: false, reason: 'NOT_FOUND' }
//   { verified: false, reason: 'ALREADY_USED' }
//   { verified: false, reason: 'EXPIRED' }
//   { verified: false, reason: 'LOCKED',   retryAfterSeconds: N }
//   { verified: false, reason: 'INVALID',  attemptsRemaining: N }
//
// ⚠️  IMPORTANT: Controllers must NEVER forward the `reason` field to clients.
//     All non-verified cases except LOCKED return the same generic HTTP message.
//     This prevents oracle attacks (attacker learns which check failed).
// ─────────────────────────────────────────────────────────────────────────────
async function verifyOtp(email, purpose, submittedOtp) {
  const normalizedEmail = email.toLowerCase().trim();

  const otpDoc = await Otp.findOne({ email: normalizedEmail, purpose })
    .sort({ createdAt: -1 });

  // ── NOT FOUND ─────────────────────────────────────────────────────────────
  if (!otpDoc) return { verified: false, reason: 'NOT_FOUND' };

  // ── ALREADY USED (replay attack guard) ───────────────────────────────────
  // Document is deleted on successful verify, but this guards the tiny race
  // window between markUsed → deleteOne in concurrent requests.
  if (otpDoc.usedAt) return { verified: false, reason: 'ALREADY_USED' };

  // ── EXPIRED (belt-and-suspenders) ────────────────────────────────────────
  // MongoDB TTL index deletes documents eventually (up to 60s lag after expiresAt).
  // Always check expiry in application code — never rely solely on TTL timing.
  if (new Date() > otpDoc.expiresAt) return { verified: false, reason: 'EXPIRED' };

  // ── LOCKED (brute-force lockout) ──────────────────────────────────────────
  if (otpDoc.lockedUntil && new Date() < otpDoc.lockedUntil) {
    const retryAfterSeconds = Math.ceil((otpDoc.lockedUntil - Date.now()) / 1000);
    return { verified: false, reason: 'LOCKED', retryAfterSeconds };
  }

  // ── VERIFY via bcrypt (timing-safe) ──────────────────────────────────────
  // bcrypt.compare runs the full hashing work regardless of where strings differ.
  // ❌ Do NOT use crypto.timingSafeEqual — bcrypt strings are variable-length,
  //    timingSafeEqual throws TypeError on length mismatch.
  let isValid = false;
  try {
    isValid = await Otp.verifyOtpHash(submittedOtp.trim(), otpDoc.otpHash);
  } catch (bcryptErr) {
    console.error('[OTPService] bcrypt.compare error:', bcryptErr.message);
    return { verified: false, reason: 'INVALID' };
  }

  // ── WRONG OTP — increment attempts ───────────────────────────────────────
  if (!isValid) {
    otpDoc.attempts += 1;

    if (otpDoc.attempts >= otpDoc.maxAttempts) {
      // Lock the document — future verify calls bounce immediately
      otpDoc.lockedUntil = new Date(Date.now() + OTP_LOCKOUT_MS);
      await otpDoc.save();

      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[OTPService] Locked | email=${normalizedEmail} | purpose=${purpose} | attempts=${otpDoc.attempts}`);
      }

      return {
        verified:           false,
        reason:             'LOCKED',
        retryAfterSeconds:  Math.ceil(OTP_LOCKOUT_MS / 1000),
      };
    }

    await otpDoc.save();

    return {
      verified:          false,
      reason:            'INVALID',
      attemptsRemaining: otpDoc.maxAttempts - otpDoc.attempts,
    };
  }

  // ── SUCCESS — mark used → delete ─────────────────────────────────────────
  // Mark first (race-condition guard), then fire-and-forget delete.
  // If deleteOne fails, MongoDB TTL cleans up within 60 seconds.
  otpDoc.usedAt = new Date();
  await otpDoc.save();

  // Non-blocking cleanup — do not await (failure is non-critical)
  Otp.deleteOne({ _id: otpDoc._id }).catch(err =>
    console.error('[OTPService] Cleanup deleteOne error:', err.message)
  );

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[OTPService] Verified ✅ | email=${normalizedEmail} | purpose=${purpose}`);
  }

  return { verified: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// invalidateOtps(email, purpose)
//
// Explicitly invalidates all OTPs for a given email+purpose.
// Call this after a successful registration, login, or password reset
// to ensure no stale OTPs remain in the collection.
// ─────────────────────────────────────────────────────────────────────────────
async function invalidateOtps(email, purpose) {
  try {
    await Otp.deleteMany({ email: email.toLowerCase().trim(), purpose });
  } catch (err) {
    // Non-fatal — log but don't rethrow. TTL will clean up.
    console.error('[OTPService] invalidateOtps error:', err.message);
  }
}

module.exports = { sendOtp, verifyOtp, invalidateOtps };
