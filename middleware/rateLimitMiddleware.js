/**
 * middleware/rateLimitMiddleware.js
 * ─────────────────────────────────────────────────────────────
 * Two layers of rate limiting:
 *
 *  1. Global IP-based rate limit (express-rate-limit)
 *  2. User-level session-creation rate limit (DB-backed, 2-hour cooldown)
 *
 * FIX: sessionCreationCooldown was querying with snake_case field
 * `creator_id` and `created_at` which don't exist in the GamingSession
 * model. Corrected to camelCase `creatorId` and `createdAt`.
 */

const rateLimit    = require("express-rate-limit");
const GamingSession = require("../models/GamingSession");
const { isWithinSpamWindow, nextAllowedCreateTime } = require("../utils/timeUtils");

// ── 1. IP-based general limiter (100 req / 15 min) ────────────
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             100,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many requests, please slow down" },
  keyGenerator:    (req) => req.ip,
});

// ── 2. Strict limiter for session creation (5 req / 15 min) ──
const createSessionIpLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many session creation attempts. Try again later." },
  keyGenerator:    (req) => req.ip,
});

// ── 3. User-level 2-hour cooldown (DB-backed) ─────────────────
async function sessionCreationCooldown(req, res, next) {
  try {
    const userId = req.user._id;

    // ✅ FIX: Use camelCase `creatorId` and `createdAt` (was snake_case `creator_id` / `created_at`)
    const lastSession = await GamingSession.findOne({ creatorId: userId })
      .sort({ createdAt: -1 })
      .select("createdAt");

    if (lastSession && isWithinSpamWindow(lastSession.createdAt)) {
      const nextAt = nextAllowedCreateTime(lastSession.createdAt);
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
