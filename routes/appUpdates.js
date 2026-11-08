// routes/appUpdates.js
// -----------------------------------------------------------------------------
// App Update Management — what the Android app calls. Mounted at /api/app-updates.
//
//   GET  /android?versionCode=21&versionName=1.0.21&installId=…   the update the app should show
//   POST /android/events   { releaseId, event, updateType }        prompt counters (no user ids)
//
// Works signed in or not (an unsupported version must be told so before sign-in). When a
// valid session token is sent, the user's installed version is recorded for analytics and
// the user id is the rollout identity; an invalid or missing token is simply anonymous —
// never a 401, so a stale session can't hide a mandatory update.
// Only published configuration is ever returned.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { sessionRejection, SESSION_FIELDS } = require('../utils/sessionGuard');
const service = require('../services/appUpdates/appUpdateService');

const router = express.Router();

const checkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many update checks. Try again later.' },
});
const eventLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests.' },
});

/** req.user when a valid, current session token is present; otherwise anonymous. */
async function optionalUser(req) {
  const header = req.header('Authorization') || '';
  if (!header.startsWith('Bearer ') || !process.env.JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select(`_id role tokenVersion ${SESSION_FIELDS}`).lean();
    if (!user || sessionRejection(decoded, user)) return null;
    return user;
  } catch (_) {
    return null;
  }
}

const handle = fn => async (req, res) => {
  try {
    const { status = 200, ...body } = await fn(req);
    res.status(status).json(body);
  } catch (err) {
    console.error(`[app-updates] ${req.method} ${req.path}:`, err && err.name, err && err.message);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong.' });
  }
};

router.get('/android', checkLimiter, handle(async req => {
  res_noStore(req);
  const user = await optionalUser(req);
  const q = req.query || {};
  return service.checkForClient({
    versionCode: typeof q.versionCode === 'string' ? q.versionCode : undefined,
    versionName: typeof q.versionName === 'string' ? q.versionName : undefined,
    installId: typeof q.installId === 'string' ? q.installId : undefined,
    user,
  });
}));

router.post('/android/events', eventLimiter, express.json({ limit: '2kb' }), handle(async req => {
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  return service.recordEvent({ releaseId: b.releaseId, event: b.event, updateType: b.updateType });
}));

// The policy can change at any moment: never let a proxy cache it.
function res_noStore(req) { req.res.set('Cache-Control', 'no-store'); }

module.exports = router;
