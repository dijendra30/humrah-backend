// models/Otp.js — Secure OTP storage
// Replaces global.otpStore in-memory hack.
// Features: SHA-256 hashing + pepper, MongoDB TTL auto-delete,
//           attempt tracking, lockout, replay prevention.

const mongoose = require('mongoose');
const crypto   = require('crypto');

const otpSchema = new mongoose.Schema({
  email: {
    type:      String,
    required:  true,
    lowercase: true,
    trim:      true,
    index:     true
  },

  // OTP is never stored in plaintext — SHA-256(rawOtp + OTP_PEPPER)
  hashedOtp: {
    type:     String,
    required: true
  },

  purpose: {
    type:     String,
    enum:     ['registration', 'password_reset', 'login'],
    required: true
  },

  // Incremented on every wrong guess
  attempts: {
    type:    Number,
    default: 0
  },

  // Set after MAX_ATTEMPTS wrong guesses — all verify calls blocked until this time
  lockedUntil: {
    type:    Date,
    default: null
  },

  // MongoDB TTL index on this field — document auto-deleted after expiry (no cron needed)
  expiresAt: {
    type:     Date,
    required: true
  },

  // Stamped when OTP is successfully verified — prevents replay attacks
  usedAt: {
    type:    Date,
    default: null
  },

  ipAddress: { type: String, default: null },
  userAgent: { type: String, default: null },

  createdAt: {
    type:    Date,
    default: Date.now
  }
});

// ── Indexes ───────────────────────────────────────────────────────────────────
// TTL index: MongoDB auto-deletes documents once expiresAt is past
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Compound index for fast lookup by email + purpose
otpSchema.index({ email: 1, purpose: 1 });

// ── Static: hash OTP with server-side pepper ──────────────────────────────────
// Pepper is a server secret (env var) — makes rainbow table attacks impossible
// even if attacker dumps the MongoDB otps collection
otpSchema.statics.hashOtp = function (rawOtp) {
  const pepper = process.env.OTP_PEPPER || 'humrah-default-pepper-change-in-prod';
  return crypto.createHash('sha256').update(rawOtp + pepper).digest('hex');
};

// ── Static: generate cryptographically secure 6-digit OTP ────────────────────
// crypto.randomInt uses CSPRNG (OS entropy) — NOT Math.random() which is predictable
otpSchema.statics.generateSecureOtp = function () {
  return crypto.randomInt(100000, 1000000).toString();
};

module.exports = mongoose.model('Otp', otpSchema);
