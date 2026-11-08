// routes/engagementNotificationsAdmin.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — operator API (Phase 1 status + Phase 2 templates).
//
//   GET  /api/admin/engagement-notifications/status
//   POST /api/admin/engagement-notifications/templates/generate        start one AI batch (202)
//   GET  /api/admin/engagement-notifications/templates                 list (filters, pages)
//   GET  /api/admin/engagement-notifications/templates/:id             one template
//   POST /api/admin/engagement-notifications/templates/:id/approve     DRAFT → APPROVED
//   POST /api/admin/engagement-notifications/templates/:id/reject      DRAFT|APPROVED → REJECTED
//   POST /api/admin/engagement-notifications/templates/:id/activate    APPROVED|PAUSED → ACTIVE
//   POST /api/admin/engagement-notifications/templates/:id/pause       ACTIVE → PAUSED
//   POST /api/admin/engagement-notifications/templates/:id/archive     → ARCHIVED
//   POST /api/admin/engagement-notifications/templates/:id/revise      new DRAFT version
//   GET  /api/admin/engagement-notifications/generation-batches        history
//   GET  /api/admin/engagement-notifications/generation-batches/:id    one batch
//   GET  /api/admin/engagement-notifications/ai/providers              provider health
//
// Mounted in server.js behind `authenticate` + `superAdminOnly`, under /api/admin (the
// Admin Dashboard session gate + CSRF), and listed as an owner-only area in
// services/adminAuth/adminPermissions.js — the existing admin architecture, unchanged.
// Nothing here can send a notification, change who receives one, or touch the worker.
// Responses never include credentials, provider messages or internal errors; failures
// answer with a stable code. server.js shuts down on an unhandled rejection, so every
// handler catches everything.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const store = () => require('../services/engagement/templateStore');
const generator = () => require('../services/engagement/ai/generator');

const fail = (res, status, code, extra = {}) => res.status(status).json({ success: false, code, ...extra });
const adminId = req => (req.user && req.user._id) || null;
const wrap = name => fn => async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return await fn(req, res);
  } catch (err) {
    console.error(`[ENGAGEMENT] admin_${name}_failed ${(err && err.name) || 'Error'}`);
    return fail(res, 500, 'INTERNAL_ERROR', { message: 'Something went wrong. Try again.' });
  }
};

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `admin:${req.user && req.user._id ? String(req.user._id) : 'anon'}`,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  handler: (_req, res) => fail(res, 429, 'RATE_LIMITED'),
});
const generateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `admin-gen:${req.user && req.user._id ? String(req.user._id) : 'anon'}`,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  handler: (_req, res) => fail(res, 429, 'RATE_LIMITED'),
});

// The fields an admin sees. Everything is generic copy and metadata; no user data exists here.
const TEMPLATE_FIELDS = ['_id', 'templateId', 'version', 'parentVersion', 'category', 'purpose', 'language', 'tone', 'title', 'body', 'variables',
  'source', 'provider', 'model', 'generationBatchId', 'status', 'approvedAt', 'approvedBy', 'rejectedAt', 'rejectedBy', 'rejectionReason',
  'activatedAt', 'pausedAt', 'archivedAt', 'usageCount', 'lastUsedAt', 'performanceMetadata', 'createdAt', 'updatedAt'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));
const templateView = t => pick(t, TEMPLATE_FIELDS);

router.get('/status', wrap('status')(async (req, res) => {
  const status = await require('../services/engagement/status').getStatus();
  return res.json({ success: true, ...status });
}));

// ── Generation ───────────────────────────────────────────────────────────────
router.post('/templates/generate', generateLimiter, wrap('generate')(async (req, res) => {
  const b = await generator().begin(req.body, { trigger: 'MANUAL', requestedBy: adminId(req) });
  if (!b.ok) return fail(res, b.status || 400, b.code, b.field ? { field: b.field } : {});
  // The batch finishes in the background (bounded by provider timeouts); poll its history row.
  generator().run(b.batch).catch(() => { /* run() never throws; belt and braces */ });
  return res.status(202).json({ success: true, batchId: b.batch._id, status: 'RUNNING' });
}));

router.get('/generation-batches', wrap('batches')(async (req, res) => {
  const EngagementGenerationBatch = require('../models/EngagementGenerationBatch');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 1000);
  const [items, total] = await Promise.all([
    EngagementGenerationBatch.find({}).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    EngagementGenerationBatch.countDocuments({}),
  ]);
  return res.json({ success: true, items, total, page, limit });
}));

router.get('/generation-batches/:id', wrap('batch')(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'NOT_FOUND');
  const b = await require('../models/EngagementGenerationBatch').findById(req.params.id).lean();
  if (!b) return fail(res, 404, 'NOT_FOUND');
  return res.json({ success: true, batch: b });
}));

router.get('/ai/providers', wrap('providers')(async (req, res) => {
  const h = await require('../services/engagement/ai/notificationAiService').health();
  return res.json({ success: true, ...h });
}));

// ── Templates ────────────────────────────────────────────────────────────────
router.get('/templates', wrap('list')(async (req, res) => {
  const r = await store().list(req.query);
  if (!r.ok) return fail(res, 400, r.code, { field: r.field });
  return res.json({ success: true, items: r.items.map(templateView), total: r.total, page: r.page, limit: r.limit });
}));

router.get('/templates/:id', wrap('get')(async (req, res) => {
  const t = await store().get(req.params.id);
  if (!t) return fail(res, 404, 'NOT_FOUND');
  return res.json({ success: true, template: templateView(t) });
}));

const ACTION_STATUS = { NOT_FOUND: 404, INVALID_TRANSITION: 409, CONFLICT: 409, FAILS_VALIDATION: 422, DUPLICATE: 409, INVALID_REQUEST: 400, UNKNOWN_ACTION: 400 };
const lifecycle = action => wrap(action)(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (action === 'reject' && body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 200)) return fail(res, 400, 'INVALID_REASON');
  const r = await store().transition(req.params.id, action, adminId(req), { reason: body.reason });
  if (!r.ok) return fail(res, ACTION_STATUS[r.code] || 400, r.code, { ...(r.status ? { status: r.status } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  return res.json({ success: true, template: templateView(r.template) });
});
// One line per route (not a loop), so route inventories and audits see each path.
router.post('/templates/:id/approve', writeLimiter, lifecycle('approve'));
router.post('/templates/:id/reject', writeLimiter, lifecycle('reject'));
router.post('/templates/:id/activate', writeLimiter, lifecycle('activate'));
router.post('/templates/:id/pause', writeLimiter, lifecycle('pause'));
router.post('/templates/:id/archive', writeLimiter, lifecycle('archive'));

router.post('/templates/:id/revise', writeLimiter, wrap('revise')(async (req, res) => {
  const r = await store().revise(req.params.id, req.body, adminId(req));
  if (!r.ok) return fail(res, ACTION_STATUS[r.code] || 400, r.code, { ...(r.status ? { status: r.status } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  return res.status(201).json({ success: true, template: templateView(r.template) });
}));

module.exports = router;
