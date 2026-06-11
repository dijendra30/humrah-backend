// middleware/rateLimitMiddleware.js — Production Rate Limiting
// =============================================================================
//
// INFRA: Coolify + Traefik on Oracle Cloud — exactly 1 proxy hop.
//   server.js has: app.set('trust proxy', 1)
//   Traefik sets X-Forwarded-For: <real-client-ip>
//
// STRATEGY:
//   Before login  → IP-based limits  (no userId available)
//   After login   → User-token-based limits (keyed on userId, not IP)
//   This prevents shared-IP false positives (office, carrier NAT, college WiFi)
//   while still protecting auth endpoints from brute force.
//
// LAYERS:
//   PUBLIC / PRE-AUTH (IP-keyed):
//     sendOtpLimiter       3 req / 15 min   — OTP send (expensive + spammable)
//     verifyOtpLimiter     3 req / 15 min   — OTP verify (brute-force vector)
//     loginLimiter         5 req / 15 min   — brute-force login
//     registerLimiter      5 req / 15 min   — signup spam
//     passwordResetLimiter 3 req / 15 min   — reset abuse
//     publicApiLimiter     100 req / 15 min — unauthenticated guest API reads
//
//   AUTHENTICATED (userId-keyed):
//     authApiLimiter       1500 req / 15 min — all normal app API traffic
//     chatMessageLimiter   60 req / min      — message send (per user)
//     vibeRequestLimiter   20 req / hour     — mood/vibe request button
//     nearbyMoodLimiter    300 req / 15 min  — nearby mood fetch (polling-heavy)
//     uploadLimiter        30 req / 15 min   — photo/media uploads
//     searchLimiter        100 req / 15 min  — search endpoints
//
//   SPECIAL:
//     createSessionIpLimiter  5 req / 15 min (IP) — gaming session creation
//     sessionCreationCooldown DB-backed per-user 2h cooldown
//
// KEY GENERATOR:
//   getClientIp()  — reads X-Forwarded-For directly (Traefik-safe, ::ffff: stripped)
//   getUserId()    — reads req.userId set by authenticate middleware
//
// NOTE: GamingSession is NOT imported at top level.
//   Lazy-required inside sessionCreationCooldown() only to avoid circular
//   dependency crashes that would make all exported limiters undefined.
// =============================================================================

'use strict';

const { rateLimit } = require('express-rate-limit');
const { isWithinSpamWindow, nextAllowedCreateTime } = require('../utils/timeUtils');

// =============================================================================
// KEY GENERATORS
// =============================================================================

/**
 * IP extractor — reads X-Forwarded-For directly (reliable under Traefik).
 * Strips ::ffff: so IPv4-mapped IPv6 addresses bucket together.
 */
const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = forwarded
    ? forwarded.split(',')[0].trim()
    : req.ip || req.connection?.remoteAddress || 'unknown';
  return raw.replace(/^::ffff:/, '');
};

/**
 * User ID extractor — set by authenticate middleware on all protected routes.
 * Falls back to IP so unauthenticated requests still get rate-limited.
 */
const getUserId = (req) => {
  const uid = req.userId?.toString() || req.user?._id?.toString();
  return uid ? `uid:${uid}` : `ip:${getClientIp(req)}`;
};

// =============================================================================
// SHARED BASE OPTIONS
// =============================================================================

/** Base options for IP-keyed limiters (pre-auth endpoints) */
const ipBase = {
  standardHeaders: true,
  legacyHeaders:   false,
  skipFailedRequests:     false,
  skipSuccessfulRequests: false,
  keyGenerator: getClientIp,
  validate: {
    xForwardedForHeader:    false,
    keyGeneratorIpFallback: false,
  },
};

/** Base options for user-token-keyed limiters (post-auth endpoints) */
const userBase = {
  standardHeaders: true,
  legacyHeaders:   false,
  skipFailedRequests:     false,
  skipSuccessfulRequests: false,
  keyGenerator: getUserId,
  validate: {
    xForwardedForHeader:    false,
    keyGeneratorIpFallback: false,
  },
};

// =============================================================================
// HELPER: build 429 handler
// =============================================================================
const handler429 = (message) => (_req, res) => {
  res.status(429).json({ success: false, message });
};

// =============================================================================
// PUBLIC / PRE-AUTH LIMITERS  (IP-keyed)
// =============================================================================

/** OTP send — 3 / 15 min / IP */
const sendOtpLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      3,
  handler:  handler429('Too many OTP requests from this device. Please try again in 15 minutes.'),
});

/** OTP verify — 3 / 15 min / IP */
const verifyOtpLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      3,
  handler:  handler429('Too many verification attempts. Please wait and try again.'),
});

/** Login — 5 / 15 min / IP */
const loginLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      5,
  handler:  handler429('Too many login attempts from this device. Please try again in 15 minutes.'),
});

/** Register — 5 / 15 min / IP */
const registerLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      5,
  handler:  handler429('Too many registration attempts from this device. Please try again later.'),
});

/** Password reset — 3 / 15 min / IP */
const passwordResetLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      3,
  handler:  handler429('Too many password reset requests. Please try again in 15 minutes.'),
});

/**
 * Public guest API reads — 100 / 15 min / IP
 * For unauthenticated endpoints (legal docs, check-email, etc.)
 */
const publicApiLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      100,
  handler:  handler429('Too many requests. Please try again shortly.'),
});

// =============================================================================
// AUTHENTICATED LIMITERS  (userId-keyed — prevents shared-IP false positives)
// =============================================================================

/**
 * Authenticated app APIs — 1500 / 15 min / user
 * Covers home feed, spotlight, bookings, profiles, chats list, etc.
 * A heavy user makes ~100-200 req per session; 1500 gives 7-10 normal sessions.
 */
const authApiLimiter = rateLimit({
  ...userBase,
  windowMs: 15 * 60 * 1000,
  max:      1500,
  handler:  handler429('You\'re making too many requests. Please slow down and try again shortly.'),
});

/**
 * Chat message send — 60 / min / user
 * Prevents message spam. 60/min = 1/sec which is faster than any human types.
 */
const chatMessageLimiter = rateLimit({
  ...userBase,
  windowMs: 60 * 1000,
  max:      60,
  handler:  handler429('You\'re sending messages too fast. Please slow down.'),
});

/**
 * Vibe / mood request button — 20 / hour / user
 * Prevents request spam to other users.
 */
const vibeRequestLimiter = rateLimit({
  ...userBase,
  windowMs: 60 * 60 * 1000,
  max:      20,
  handler:  handler429('You\'re sending too many requests. Please wait a while before trying again.'),
});

/**
 * Nearby mood fetch — 300 / 15 min / user
 * This endpoint is called frequently (background polling + manual refresh).
 * 300 / 15 min = 20/min which is well above any polling interval.
 */
const nearbyMoodLimiter = rateLimit({
  ...userBase,
  windowMs: 15 * 60 * 1000,
  max:      300,
  handler:  handler429('Too many location requests. Please wait a moment.'),
});

/**
 * Upload APIs — 30 / 15 min / user
 * Covers profile photo, verification photo, food post image, etc.
 */
const uploadLimiter = rateLimit({
  ...userBase,
  windowMs: 15 * 60 * 1000,
  max:      30,
  handler:  handler429('Too many uploads. Please wait before uploading again.'),
});

/**
 * Search APIs — 100 / 15 min / user
 * Covers user search, post search, etc.
 */
const searchLimiter = rateLimit({
  ...userBase,
  windowMs: 15 * 60 * 1000,
  max:      100,
  handler:  handler429('Too many search requests. Please wait a moment.'),
});

// =============================================================================
// SPECIAL / MIXED LIMITERS
// =============================================================================

/**
 * Gaming session creation — IP-keyed (5 / 15 min)
 * IP-keyed because session spam can come from throwaway accounts on same IP.
 */
const createSessionIpLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      5,
  handler:  handler429('Too many session creation attempts. Please try again later.'),
});

/**
 * Global fallback limiter — 500 / 15 min / IP
 * Applied in server.js as the outermost catch-all.
 * Only hits scrapers/DDoS at this threshold; normal users never see it
 * because the specific limiters above fire first.
 */
const globalLimiter = rateLimit({
  ...ipBase,
  windowMs: 15 * 60 * 1000,
  max:      500,
  handler:  handler429('You\'re moving a little fast \u2728 Please take a moment and try again shortly.'),
});

// =============================================================================
// DB-BACKED PER-USER GAMING SESSION COOLDOWN
// Lazy-required to avoid circular dependency at module load.
// =============================================================================
async function sessionCreationCooldown(req, res, next) {
  try {
    const GamingSession = require('../models/GamingSession');
    const userId = req.user?._id || req.userId;

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
    next(); // fail-open so a DB blip doesn't block all session creation
  }
}

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
  // Pre-auth (IP-keyed)
  globalLimiter,
  publicApiLimiter,
  sendOtpLimiter,
  verifyOtpLimiter,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,

  // Post-auth (user-keyed)
  authApiLimiter,
  chatMessageLimiter,
  vibeRequestLimiter,
  nearbyMoodLimiter,
  uploadLimiter,
  searchLimiter,

  // Special
  createSessionIpLimiter,
  sessionCreationCooldown,
};
