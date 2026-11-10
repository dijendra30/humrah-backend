// routes/inviteRoutes.js — /api/invites (Universal Group Invitations).
//
// Mounted in server.js ABOVE the `app.use('/api', authenticate, …)` catch-alls so the
// public preview stays public; every other route authenticates itself here.
//
//   POST   /api/invites                  create a link   {type, targetId, maxUses?}
//   GET    /api/invites/:token/preview   public preview (logged-out apps)
//   GET    /api/invites/:token           preview + viewer membership (signed in)
//   POST   /api/invites/:token/join      join (explicit user action only)
//   DELETE /api/invites/:token           revoke (creator or the group's host)
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { enforceLegalAcceptance } = require('../middleware/enforceLegalAcceptance');
const invites = require('../services/invitations/invitationService');
const { isWellFormed } = require('../services/invitations/inviteToken');

const router = express.Router();

const clientIp = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  const raw = typeof fwd === 'string' && fwd.length > 0 ? fwd.split(',')[0].trim() : (req.ip || 'unknown');
  return raw.replace(/^::ffff:/, '');
};
const userKey = (req) => {
  const uid = req.userId?.toString() || req.user?._id?.toString();
  return uid ? `uid:${uid}` : `ip:${clientIp(req)}`;
};
const limiter = (windowMs, max, keyGenerator, message) => rateLimit({
  windowMs, max, keyGenerator,
  standardHeaders: true, legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  handler: (_req, res) => res.status(429).json({ success: false, code: 'RATE_LIMITED', message }),
});

const createLimiter = limiter(60 * 60 * 1000, Number(process.env.INVITE_CREATE_PER_HOUR || 30), userKey,
  'You have created a lot of invite links. Please try again later.');
const joinLimiter = limiter(15 * 60 * 1000, 30, userKey, 'Too many attempts. Please try again shortly.');
const readLimiter = limiter(15 * 60 * 1000, 300, userKey, 'Too many requests. Please try again shortly.');
const publicLimiter = limiter(5 * 60 * 1000, 120, clientIp, 'Too many requests. Please try again shortly.');

const send = (res, { status, body }) => res.status(status).json(body);
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[INVITES] ${req.method} ${req.baseUrl}${req.route ? req.route.path : ''}:`, err.message);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  }
};
const invalidToken = (res) => res.status(404).json({
  success: false, state: 'INVITE_INVALID', code: 'INVITE_INVALID', message: 'This invite link is not valid.',
});
// Token-bearing responses must not be cached by anything between us and the app.
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

router.use(noStore);

router.post('/', authenticate, enforceLegalAcceptance, createLimiter, handle(async (req, res) => {
  const { type, targetId, maxUses } = req.body || {};
  send(res, await invites.createInvite(req.user, { type, targetId, maxUses }));
}));

router.get('/:token/preview', publicLimiter, handle(async (req, res) => {
  if (!isWellFormed(req.params.token)) return invalidToken(res);
  send(res, await invites.getPreview(req.params.token, null));
}));

router.get('/:token', authenticate, enforceLegalAcceptance, readLimiter, handle(async (req, res) => {
  if (!isWellFormed(req.params.token)) return invalidToken(res);
  send(res, await invites.getPreview(req.params.token, req.user));
}));

router.post('/:token/join', authenticate, enforceLegalAcceptance, joinLimiter, handle(async (req, res) => {
  if (!isWellFormed(req.params.token)) return invalidToken(res);
  send(res, await invites.joinWithToken(req.user, req.params.token, req.app.get('io')));
}));

router.delete('/:token', authenticate, readLimiter, handle(async (req, res) => {
  if (!isWellFormed(req.params.token)) return invalidToken(res);
  send(res, await invites.revokeInvite(req.user, req.params.token));
}));

module.exports = router;
