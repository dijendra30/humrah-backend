// routes/adminAppUpdates.js
// -----------------------------------------------------------------------------
// App Update Management — admin API. Mounted at /api/admin/app-updates behind
// authenticate + adminOnly in server.js; each route also checks a permission
// (services/appUpdates/appUpdatePermissions.js): viewing for any admin, changes for
// SUPER_ADMIN only. Every change is audited.
//
//   GET   /me/permissions          what this admin may do (for the UI)
//   GET   /analytics?days=30       versions in use, adoption, prompt counters
//   GET   /                        all releases (history included)
//   POST  /                        create a draft
//   GET   /:id                     one release with its change log
//   PATCH /:id                     edit (drafts fully; live releases: not the version)
//   POST  /:id/publish             publish now, or schedule { scheduledAt, scheduleTimeZone }
//   POST  /:id/pause               pause a live release (or cancel a schedule)
//   POST  /:id/withdraw            withdraw { reason } — kept as history
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const service = require('../services/appUpdates/appUpdateService');
const { PERMS, permissionsOf, requireAppUpdatePermission: need } = require('../services/appUpdates/appUpdatePermissions');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

const changeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many changes. Try again in a few minutes.' },
});

router.use((req, res, next) => {
  if (!req.user || !req.user._id) return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
  return next();
});

const handle = fn => async (req, res) => {
  try {
    const { status = 200, ...body } = await fn(req);
    res.status(status).json(body);
  } catch (err) {
    console.error(`[app-updates-admin] ${req.method} ${req.route ? req.route.path : ''}:`, err && err.name, err && err.message);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong.' });
  }
};
const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

router.get('/me/permissions', handle(async req => ({ status: 200, success: true, role: req.user.role, permissions: permissionsOf(req.user) })));
router.get('/analytics', need(PERMS.VIEW_APP_UPDATES), handle(async req => service.analytics(req.query || {})));
router.get('/', need(PERMS.VIEW_APP_UPDATES), handle(async () => service.listReleases()));
router.post('/', changeLimiter, need(PERMS.MANAGE_APP_UPDATES), handle(async req => service.createRelease(req.user, body(req), req)));
router.get('/:id', need(PERMS.VIEW_APP_UPDATES), handle(async req => service.getRelease(req.params.id)));
router.patch('/:id', changeLimiter, need(PERMS.MANAGE_APP_UPDATES), handle(async req => service.updateRelease(req.user, req.params.id, body(req), req)));
router.post('/:id/publish', changeLimiter, need(PERMS.MANAGE_APP_UPDATES), handle(async req => service.publishRelease(req.user, req.params.id, body(req), req)));
router.post('/:id/pause', changeLimiter, need(PERMS.MANAGE_APP_UPDATES), handle(async req => service.pauseRelease(req.user, req.params.id, body(req), req)));
router.post('/:id/withdraw', changeLimiter, need(PERMS.MANAGE_APP_UPDATES), handle(async req => service.withdrawRelease(req.user, req.params.id, body(req), req)));

module.exports = router;
