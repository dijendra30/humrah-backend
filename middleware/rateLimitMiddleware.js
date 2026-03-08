/**
 * middleware/rateLimitMiddleware.js
 * ─────────────────────────────────────────────────────────────
 * Two layers of rate limiting:
 *
 *  1. Global IP-based rate limit (express-rate-limit)
 *     — catches burst abuse before JWT is even verified.
 *
 *  2. User-level session-creation rate limit
 *     — 1 session per 2 hours per authenticated user.
 *     — Reads from MongoDB (same source of truth as the service).
 */

const rateLimit = require("express-rate-limit");
const GamingSession = require("../models/GamingSession");
const { isWithinSpamWindow, nextAllowedCreateTime } = require("../utils/timeUtils");

// ── 1. IP-based general limiter (100 req / 15 min) ────────────
const globalLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,  // 15 minutes
  max:              100,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: "Too many requests, please slow down" },
  keyGenerator:     (req) => req.ip,
});

// ── 2. Strict limiter for session creation (5 req / 15 min) ──
//    Acts as a secondary guard in addition to the 2-hour DB check.
const createSessionIpLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many session creation attempts. Try again later." },
  keyGenerator:    (req) => req.ip,
});

// ── 3. User-level 2-hour cooldown (DB-backed) ─────────────────
/**
 * Must be used AFTER authMiddleware so req.user is populated.
 * Queries MongoDB to check the user's most recent session.
 */
async function sessionCreationCooldown(req, res, next) {
  try {
    const userId = req.user._id;

    const lastSession = await GamingSession.findOne({ creator_id: userId })
      .sort({ created_at: -1 })
      .select("created_at");

    if (lastSession && isWithinSpamWindow(lastSession.created_at)) {
      const nextAt = nextAllowedCreateTime(lastSession.created_at);
      return res.status(429).json({
        error:           "You can only create one session every 2 hours",
        next_allowed_at: nextAt.toISOString(),
      });
    }

    next();
  } catch (err) {
    console.error("[RateLimit] sessionCreationCooldown error:", err.message);
    next(); // fail open — don't block users on infra errors
  }
}

module.exports = {
  globalLimiter,
  createSessionIpLimiter,
  sessionCreationCooldown,
};
