// middleware/rateLimitMiddleware.js — Centralized Rate Limiting (Production-Grade)
// ─────────────────────────────────────────────────────────────────────────────
//
// express-rate-limit v7+ REQUIRED CHANGE:
//   Use ipKeyGenerator() for any keyGenerator using req.ip.
//   Without it, IPv6 addresses like "::ffff:1.2.3.4" are not normalized,
//   allowing an attacker to bypass limits via IPv6/IPv4 dual-stack variants.
//
// LAYERED RATE-LIMIT STRATEGY:
//   Layer 1: globalLimiter   — broad IP-level throttle across all endpoints
//   Layer 2: sendOtpLimiter  — tight limit on OTP generation (expensive, spammable)
//   Layer 3: verifyOtpLimiter — tight limit on OTP verification (brute-force vector)
//   Layer 4: otpService DB cooldown — per-email, cross-instance (bypasses layer 2-3)
//   Layer 5: Otp.attempts+lockedUntil — per-document lockout stored in MongoDB
//
// WHY MULTIPLE LAYERS:
//   No single layer is sufficient. IP-based limits can be bypassed with proxies.
//   In-memory limits reset on restart and don't work across Render instances.
//   DB-backed limits survive restarts and work across all instances.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const GamingSession                  = require('../models/GamingSession');
const { isWithinSpamWindow, nextAllowedCreateTime } = require('../utils/timeUtils');

// ── Shared base options applied to all limiters ───────────────────────────────
const sharedOptions = {
  standardHeaders: true,   // Emit RateLimit-* headers (RFC 6585)
  legacyHeaders:   false,  // Suppress deprecated X-RateLimit-* headers
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Global limiter — 100 requests per 15 minutes per IP
//    Applied to ALL routes in server.js before everything else.
//    Broad defense against DDoS and mass scanning.
// ─────────────────────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  ...sharedOptions,
  windowMs:     15 * 60 * 1000,
  max:          100,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests from this device. Please slow down and try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OTP send limiter — 3 requests per 15 minutes per IP
//    Prevents OTP spam (each request triggers email → costs money + annoys users).
//    Note: DB-level per-email cooldown (otpService) is an additional layer.
// ─────────────────────────────────────────────────────────────────────────────
const sendOtpLimiter = rateLimit({
  ...sharedOptions,
  windowMs:     15 * 60 * 1000,
  max:          3,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many OTP requests from this device. Please try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OTP verify limiter — 5 requests per 10 minutes per IP
//    Slows brute-force against 6-digit OTPs before DB-level lockout triggers.
//    6-digit space = 900,000 possibilities. At 5/10min → 6.5 days to exhaust.
// ─────────────────────────────────────────────────────────────────────────────
const verifyOtpLimiter = rateLimit({
  ...sharedOptions,
  windowMs:     10 * 60 * 1000,
  max:          5,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many verification attempts. Please wait and try again.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Login limiter — 10 requests per 15 minutes per IP
// ─────────────────────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  ...sharedOptions,
  windowMs:     15 * 60 * 1000,
  max:          10,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many login attempts. Please try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Registration limiter — 5 requests per hour per IP
// ─────────────────────────────────────────────────────────────────────────────
const registerLimiter = rateLimit({
  ...sharedOptions,
  windowMs:     60 * 60 * 1000,
  max:          5,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many registration attempts from this IP. Please try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Password reset limiter — 5 requests per hour per IP
// ─────────────────────────────────────────────────────────────────────────────
const passwordResetLimiter = rateLimit({
  ...sharedOptions,
  windowMs:     60 * 60 * 1000,
  max:          5,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many password reset requests. Please try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Gaming session IP limiter — 5 per 15 minutes per IP
// ─────────────────────────────────────────────────────────────────────────────
const createSessionIpLimiter = rateLimit({
  ...sharedOptions,
  windowMs:     15 * 60 * 1000,
  max:          5,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many session creation attempts. Please try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Gaming session user-level cooldown (DB-backed, cross-instance safe)
//    2-hour cooldown stored in MongoDB — survives restarts and load balancers.
// ─────────────────────────────────────────────────────────────────────────────
async function sessionCreationCooldown(req, res, next) {
  try {
    const userId = req.user._id;

    const lastSession = await GamingSession.findOne({ creatorId: userId })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    if (lastSession && isWithinSpamWindow(lastSession.createdAt)) {
      const nextAt = nextAllowedCreateTime(lastSession.createdAt);
      return res.status(429).json({
        success:         false,
        error:           'You can only create one session every 2 hours.',
        next_allowed_at: nextAt.toISOString(),
      });
    }

    next();
  } catch (err) {
    // Non-fatal — fail open so genuine users aren't blocked by a DB glitch
    console.error('[RateLimit] sessionCreationCooldown error:', err.message);
    next();
  }
}

module.exports = {
  globalLimiter,
  sendOtpLimiter,
  verifyOtpLimiter,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
  createSessionIpLimiter,
  sessionCreationCooldown,
};
