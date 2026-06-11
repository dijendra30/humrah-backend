// routes/liveLocationRoutes.js
// Auth is applied globally in server.js EXCEPT for the public GET endpoint.
// Pattern used: public GET is registered separately before auth middleware.

const express    = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router     = express.Router();
const ctrl       = require('../controllers/liveLocationController');

// Rate limit: live location update — 1 update per 15 seconds per IP
// (prevents Android bugs from spamming the backend)
const updateLimiter = rateLimit({
  windowMs:         15 * 1000,      // 15 seconds
  max:              1,
  standardHeaders:  true,
  legacyHeaders:    false,
  keyGenerator:     ipKeyGenerator,
  message: { success: false, message: 'Too many location updates. Please slow down.' },
  skip: () => process.env.NODE_ENV === 'development', // skip in dev for easy testing
});

// Rate limit: polling by trusted contacts — 4 polls/minute per IP (every 15s)
const pollLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              6,              // a little slack above the 4 required
  standardHeaders:  true,
  legacyHeaders:    false,
  keyGenerator:     ipKeyGenerator,
  message: { success: false, message: 'Too many requests.' },
});

// ─── PUBLIC (no auth) ────────────────────────────────────────────────────────
// GET /api/live-location/:sessionId — polled by browser tracking page
router.get('/:sessionId', pollLimiter, ctrl.get);

// ─── AUTHENTICATED ────────────────────────────────────────────────────────────
// These are all called from the Android app with a valid JWT.
router.post('/start',  ctrl.start);
router.post('/update', updateLimiter, ctrl.update);
router.post('/stop',   ctrl.stop);

module.exports = router;
module.exports.liveLocationPollLimiter = pollLimiter;
