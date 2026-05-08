// models/Otp.js — Secure OTP Storage Schema (Production-Grade)
// ─────────────────────────────────────────────────────────────────────────────
//
// ❌ WHY GLOBAL MEMORY (global.otpStore / Map) BREAKS IN MULTI-INSTANCE:
//   Render.com deploys multiple Node.js processes behind a load balancer.
//   Instance A generates OTP → stores in its Map → verify request hits Instance B
//   → Map is EMPTY → always fails. Restarts wipe in-memory state instantly.
//   MongoDB is the single shared source of truth across ALL instances.
//
// ✅ WHY WE HASH OTPs WITH bcrypt + PEPPER:
//   1. If attacker dumps MongoDB `otps` collection, they get hashes not OTPs.
//   2. bcrypt cost=10 → ~100ms per attempt on modern hardware.
//   3. OTP_PEPPER = server secret — cracking requires DB dump AND server secret.
//   4. 900,000 possible 6-digit OTPs × 100ms = ~25 hours per hash, PLUS 5-attempt
//      DB lockout = brute-force via DB dump is effectively impossible.
//
// 🛡️ BRUTE-FORCE PREVENTION (layered defense-in-depth):
//   Layer 1: express-rate-limit       → blocks IPs after N requests (fast, memory)
//   Layer 2: DB resend cooldown        → per-email throttle, cross-instance safe
//   Layer 3: attempts + lockedUntil   → after 5 wrong OTPs, locked 15 min in DB
//   Layer 4: bcrypt slow hashing      → expensive even if layers 1-3 bypassed
//   Layer 5: MongoDB TTL auto-delete  → OTP gone after 10 min (tiny attack window)
//   Layer 6: Generic error messages   → attacker cannot distinguish wrong vs expired
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

// bcrypt cost factor — 10 rounds ≈ 100ms on modern hardware.
// High enough to slow brute-force, low enough for acceptable API response time.
const BCRYPT_ROUNDS = 10;

const otpSchema = new mongoose.Schema(
  {
    // Always stored lowercase+trimmed. Indexed for fast lookup.
    email: {
      type:      String,
      required:  [true, 'Email is required'],
      lowercase: true,
      trim:      true,
      index:     true,
    },

    // ⚠️  NEVER store plaintext OTPs here.
    // Value = bcrypt( rawOtp + OTP_PEPPER, rounds )
    // Named otpHash — do NOT rename or alias this field.
    otpHash: {
      type:     String,
      required: [true, 'OTP hash is required'],
    },

    // Scopes OTP to a specific flow — a registration OTP cannot be replayed
    // as a login OTP even if both share the same 6 digits.
    purpose: {
      type:     String,
      enum:     ['registration', 'login', 'password_reset'],
      required: [true, 'Purpose is required'],
      index:    true,
    },

    // Brute-force attempt counter. Incremented on each wrong guess.
    attempts: {
      type:    Number,
      default: 0,
      min:     0,
    },

    // Maximum wrong guesses before lockout. Default 5.
    maxAttempts: {
      type:    Number,
      default: 5,
      min:     1,
    },

    // Set after maxAttempts failures. All verify calls blocked until past this.
    // Cleared only when a fresh OTP is requested (deleteMany on resend).
    lockedUntil: {
      type:    Date,
      default: null,
    },

    // MongoDB TTL index on this field drives automatic document deletion.
    // expireAfterSeconds: 0 = "delete exactly at expiresAt".
    // App layer ALSO checks this explicitly — belt-and-suspenders.
    expiresAt: {
      type:     Date,
      required: [true, 'Expiry time is required'],
    },

    // Replay-attack prevention. Set to Date on successful verify.
    // Document is deleted on success, but usedAt guards the race-condition window.
    usedAt: {
      type:    Date,
      default: null,
    },

    // Audit / forensics only — never used in business logic or error responses.
    ipAddress: { type: String, default: null, select: false },
    userAgent: { type: String, default: null, select: false },
  },
  {
    timestamps: true,   // adds createdAt + updatedAt automatically
    versionKey: false,  // removes __v field
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

// TTL index: MongoDB background job deletes documents at expiresAt.
// Note: TTL deletion can lag up to 60 seconds — always check expiresAt in app code.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index: optimises findOne({ email, purpose }) — the most common query.
otpSchema.index({ email: 1, purpose: 1 });

// ── Static: generateSecureOtp ─────────────────────────────────────────────────
// crypto.randomInt uses CSPRNG (OS entropy) — completely unpredictable.
// ❌ Do NOT use: Math.random()     (Mersenne Twister, predictable once seeded)
// ❌ Do NOT use: Date.now() % 1M   (time-based, trivially guessable)
otpSchema.statics.generateSecureOtp = function () {
  // [100000, 1000000) ensures always exactly 6 digits — no leading-zero edge cases.
  return crypto.randomInt(100000, 1000000).toString();
};

// ── Static: hashOtp ───────────────────────────────────────────────────────────
// ASYNC — must be awaited. Returns Promise<string>.
// Pepper is a server-side secret mixed BEFORE hashing so a DB-only breach
// does not expose crackable hashes (attacker needs DB dump + server secret).
otpSchema.statics.hashOtp = async function (rawOtp) {
  const pepper = process.env.OTP_PEPPER;
  if (!pepper) {
    throw new Error('[Otp.hashOtp] OTP_PEPPER env var is not set. Cannot hash OTP.');
  }
  // Concatenate pepper BEFORE bcrypt so it is inside the bcrypt work factor.
  return bcrypt.hash(rawOtp + pepper, BCRYPT_ROUNDS);
};

// ── Static: verifyOtpHash ─────────────────────────────────────────────────────
// ASYNC — must be awaited. Returns Promise<boolean>.
// bcrypt.compare is inherently timing-safe — it always runs the full bcrypt work
// regardless of where the strings differ.
// ❌ Do NOT use crypto.timingSafeEqual here: bcrypt outputs are variable-length
//    strings not fixed-length buffers — timingSafeEqual throws on length mismatch.
otpSchema.statics.verifyOtpHash = async function (rawOtp, storedHash) {
  const pepper = process.env.OTP_PEPPER;
  if (!pepper) {
    throw new Error('[Otp.verifyOtpHash] OTP_PEPPER env var is not set.');
  }
  return bcrypt.compare(rawOtp + pepper, storedHash);
};

module.exports = mongoose.model('Otp', otpSchema);
