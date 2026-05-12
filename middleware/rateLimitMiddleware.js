// middleware/rateLimitMiddleware.js — Centralized Rate Limiting (Production-Grade)
// ─────────────────────────────────────────────────────────────────────────────
//
// INFRA: Coolify + Traefik on Oracle Cloud — exactly 1 proxy hop.
//   server.js has: app.set('trust proxy', 1)
//   Traefik sets X-Forwarded-For: <real-client-ip>
//
// KEY GENERATOR:
//   We do NOT use ipKeyGenerator from express-rate-limit.
//   Reason: ipKeyGenerator reads req.ip, which under some Traefik configs
//   still resolves to the container's internal IP (same for every request),
//   making the rate limiter count all traffic as one bucket → 429 never fires.
//
//   Instead we use a manual keyGenerator that reads X-Forwarded-For directly,
//   strips the IPv6 prefix (::ffff:) for normalization, and falls back to
//   req.ip if the header is missing. This is reliable across Traefik versions.
//
// LAYERED RATE-LIMIT STRATEGY:
//   Layer 1: globalLimiter    — broad IP-level throttle across all endpoints
//   Layer 2: sendOtpLimiter   — tight limit on OTP generation (expensive, spammable)
//   Layer 3: verifyOtpLimiter — tight limit on OTP verification (brute-force vector)
//   Layer 4: otpService DB cooldown — per-email, cross-instance safe
//   Layer 5: Otp.attempts+lockedUntil — per-document lockout stored in MongoDB
//
// IMPORTANT: GamingSession is NOT imported at top level.
//   Lazy-required inside sessionCreationCooldown() only to avoid circular
//   dependency crashes that would make all exported limiters undefined.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { rateLimit } = require('express-rate-limit');
const { isWithinSpamWindow, nextAllowedCreateTime } = require('../utils/timeUtils');

// ─────────────────────────────────────────────────────────────────────────────
// REAL IP EXTRACTOR
// Reads X-Forwarded-For directly — more reliable than req.ip under Traefik.
// Strips ::ffff: prefix so IPv4-mapped IPv6 addresses count as one bucket.
// Also logs the resolved IP on every request so you can verify in server logs.
// ─────────────────────────────────────────────────────────────────────────────
const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = forwarded
    ? forwarded.split(',')[0].trim()   // leftmost = real client IP
    : req.ip || req.connection.remoteAddress || 'unknown';
  return raw.replace(/^::ffff:/, ''); // normalise IPv4-mapped IPv6
};

// ── Shared base options applied to all limiters ───────────────────────────────
const sharedOptions = {
  standardHeaders: true,
  legacyHeaders:   false,
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  keyGenerator: getClientIp,
  // We intentionally read X-Forwarded-For directly (not via req.ip) because
  // Traefik on Coolify can resolve req.ip to the container's internal address.
  // Suppress express-rate-limit's IPv6 keyGenerator validation warning since
  // our getClientIp already handles ::ffff: normalisation correctly.
  validate: { xForwardedForHeader: false, ip: false },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Global limiter — 100 requests per 15 minutes per IP
// ─────────────────────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  ...sharedOptions,
  windowMs: 15 * 60 * 1000,
  max:      100,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests from this device. Please slow down and try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OTP send limiter — 3 requests per 15 minutes per IP
// ─────────────────────────────────────────────────────────────────────────────
const sendOtpLimiter = rateLimit({
  ...sharedOptions,
  windowMs: 15 * 60 * 1000,
  max:      3,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many OTP requests from this device. Please try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OTP verify limiter — 5 requests per 10 minutes per IP
// ─────────────────────────────────────────────────────────────────────────────
const verifyOtpLimiter = rateLimit({
  ...sharedOptions,
  windowMs: 10 * 60 * 1000,
  max:      5,
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
  windowMs: 15 * 60 * 1000,
  max:      10,
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
  windowMs: 60 * 60 * 1000,
  max:      5,
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
  windowMs: 60 * 60 * 1000,
  max:      5,
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
  windowMs: 15 * 60 * 1000,
  max:      5,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many session creation attempts. Please try again later.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Gaming session user-level cooldown (DB-backed, cross-instance safe)
//    GamingSession lazy-required to avoid circular dependency at module load.
// ─────────────────────────────────────────────────────────────────────────────
async function sessionCreationCooldown(req, res, next) {
  try {
    const GamingSession = require('../models/GamingSession');
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
