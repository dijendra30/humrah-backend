// middleware/roomGuards.js
// -----------------------------------------------------------------------------
// R1 hardening middleware for Humrah Rooms:
//   - validateRoomId : malformed :roomId -> HTTP 400 (never a CastError -> 500)
//   - roomCreateLimiter / roomJoinLimiter : Redis-backed per-user rate limits
//
// The generic express-rate-limit limiters in rateLimitMiddleware.js use an
// in-memory store; these use redisService so the control is multi-instance safe
// when Redis is configured (and degrades to best-effort in dev without Redis).
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const redisService = require('../services/redisService');

/**
 * Rejects a request whose :roomId param is not a valid Mongo ObjectId.
 * Placed before controllers so a bad id can never reach findById().
 */
function validateRoomId(req, res, next) {
  const { roomId } = req.params;
  // isValid() is false for any string that would throw a CastError in findById()
  // (e.g. "abc", "123"). 24-hex and 12-byte strings pass and, if they don't match
  // a document, correctly fall through to the controller's 404.
  if (!roomId || !mongoose.Types.ObjectId.isValid(roomId)) {
    return res.status(400).json({ success: false, message: 'Invalid room id' });
  }
  next();
}

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Sensible defaults, override via env.
const CREATE_LIMIT  = num(process.env.ROOM_CREATE_RATE_LIMIT, 5);
const CREATE_WINDOW = num(process.env.ROOM_CREATE_RATE_WINDOW_SECONDS, 3600);   // 5 / hour
const JOIN_LIMIT    = num(process.env.ROOM_JOIN_RATE_LIMIT, 20);
const JOIN_WINDOW   = num(process.env.ROOM_JOIN_RATE_WINDOW_SECONDS, 3600);     // 20 / hour

/**
 * Builds a per-authenticated-user fixed-window limiter.
 * Fails OPEN on Redis error so a transient outage never blocks all Room usage.
 */
function buildLimiter({ action, limit, windowSeconds, message }) {
  return async function (req, res, next) {
    const userId = req.userId || req.user?._id;
    if (!userId) return next(); // authenticate middleware runs first; defensive only
    const key = `ratelimit:room:${action}:${userId}`;
    try {
      const count = await redisService.incrementWithWindow(key, windowSeconds);
      if (count > limit) {
        return res.status(429).json({ success: false, message });
      }
      return next();
    } catch (err) {
      console.error(`[roomGuards] rate limit ${action} failed open:`, err.message);
      return next();
    }
  };
}

const roomCreateLimiter = buildLimiter({
  action: 'create',
  limit: CREATE_LIMIT,
  windowSeconds: CREATE_WINDOW,
  message: 'You are creating Rooms too quickly. Please try again later.',
});

const roomJoinLimiter = buildLimiter({
  action: 'join',
  limit: JOIN_LIMIT,
  windowSeconds: JOIN_WINDOW,
  message: 'You are joining Rooms too quickly. Please try again later.',
});

module.exports = {
  validateRoomId,
  roomCreateLimiter,
  roomJoinLimiter,
  _config: { CREATE_LIMIT, CREATE_WINDOW, JOIN_LIMIT, JOIN_WINDOW },
};
