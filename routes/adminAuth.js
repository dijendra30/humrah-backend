// routes/adminAuth.js — Admin Dashboard sign-in (mounted at /api/admin/auth, ABOVE the admin gate).
//
//   POST /request-otp   { email }                      → code to the fixed support mailbox; generic reply
//   POST /resend-otp    { email, challengeId }         → new code (60 s cooldown); previous code dies
//   POST /verify-otp    { email, challengeId, otp }    → HttpOnly session cookie + CSRF token
//   GET  /me                                           → current admin, CSRF token, session timing
//   POST /logout                                       → session revoked, cookie cleared
//   POST /socket-token                                 → 2-minute token for the founder-chat socket handshake
//   GET  /security-events                              → SUPER_ADMIN: recent security log
//
// No request field can choose where a code is sent; that is ADMIN_OTP_DESTINATION on the server.
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config/adminAuthConfig');
const login = require('../services/adminAuth/adminLoginService');
const sessions = require('../services/adminAuth/adminSessionService');
const identity = require('../services/adminAuth/adminIdentity');
const securityLog = require('../services/adminAuth/adminSecurityLog');
const { adminSessionGate, requireRole, originAllowed, ADMIN_SOCKET_SCOPE } = require('../middleware/adminSessionGate');

const router = express.Router();

// Never cache anything here; refuse plain HTTP in production; refuse foreign browser origins.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  if (config.get().requireHttps && !req.secure) {
    return res.status(400).json({ success: false, code: 'HTTPS_REQUIRED', message: 'Admin sign-in requires HTTPS.' });
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ success: false, code: 'ORIGIN_NOT_ALLOWED', message: 'This origin is not allowed.' });
  }
  return next();
});

const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[admin-auth] ${req.method} ${req.route ? req.route.path : ''}:`, err && err.name, err && err.message);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  }
};

function sendResult(res, result) {
  if (result.status === 429 && result.body.retryAfterSeconds) res.set('Retry-After', String(result.body.retryAfterSeconds));
  return res.status(result.status).json(result.body);
}

router.post('/request-otp', handle(async (req, res) => sendResult(res, await login.requestOtp(req, body(req)))));
router.post('/resend-otp', handle(async (req, res) => sendResult(res, await login.resendOtp(req, body(req)))));

router.post('/verify-otp', handle(async (req, res) => {
  const result = await login.verifyOtp(req, body(req));
  if (result.status === 200 && result.session) {
    // Session rotation / fixation: any session this browser already had is ended first.
    const previous = sessions.readCookie(req);
    if (previous) {
      const r = await sessions.resolve(previous);
      if (r.session) await sessions.revoke(r.session, 'ROTATED');
    }
    sessions.setCookie(res, result.session.raw);
  }
  return sendResult(res, result);
}));

const requireSession = adminSessionGate({ adminOnly: true, cookieOnly: true });

router.get('/me', requireSession, handle(async (req, res) => {
  res.json({
    success: true,
    admin: identity.safeAdminProfile(req.user),
    csrfToken: sessions.csrfTokenOf(req.adminSession),
    session: sessions.describe(req.adminSession),
  });
}));

// Logout does not need the CSRF token (it can only end a session), but foreign origins are refused above.
router.post('/logout', handle(async (req, res) => {
  const raw = sessions.readCookie(req);
  if (raw) {
    const r = await sessions.resolve(raw);
    if (r.session) {
      await sessions.revoke(r.session, 'LOGOUT');
      if (r.ok) securityLog.record('LOGOUT', req, { email: r.session.email, authorised: true, userId: r.session.userId });
    }
  }
  sessions.clearCookie(res);
  res.json({ success: true, message: 'Signed out.' });
}));

router.post('/socket-token', requireSession, handle(async (req, res) => {
  const ttl = config.get().socketTokenTtlSeconds;
  const token = jwt.sign(
    { userId: String(req.user._id), role: req.user.role, tv: req.user.tokenVersion ?? 0, scope: ADMIN_SOCKET_SCOPE, asid: String(req.adminSession._id) },
    process.env.JWT_SECRET,
    { expiresIn: ttl },
  );
  res.json({ success: true, token, expiresInSeconds: ttl });
}));

router.get('/security-events', requireSession, requireRole('SUPER_ADMIN'), handle(async (req, res) => {
  const AdminSecurityEvent = require('../models/AdminSecurityEvent');
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const filter = {};
  if (typeof req.query.type === 'string' && AdminSecurityEvent.TYPES.includes(req.query.type)) filter.type = req.query.type;
  const events = await AdminSecurityEvent.find(filter).sort({ at: -1 }).limit(limit).select('-ipHash -emailHash').lean();
  res.json({ success: true, events });
}));

module.exports = router;
