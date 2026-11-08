// routes/engagementNotificationsAdmin.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — operator API (Phases 1–3).
//
//   Phase 1  GET  /status
//   Phase 2  POST /templates/generate              start one AI batch (202)
//            GET  /templates                       list (filters, pages)
//            GET  /templates/:id                   one template
//            POST /templates/:id/approve|reject|activate|pause|archive|revise
//            GET  /generation-batches              history (filters, pages)
//            GET  /generation-batches/:id          one batch
//            GET  /ai/providers                    provider health (+ 7-day outcomes)
//   Phase 3  GET  /options                         categories, purposes, variables, limits
//            GET  /monitor                         worker state, heartbeat, queue health
//            GET  /queue                           privacy-safe queue rows (filters, pages)
//            POST /queue/:id/requeue               requeue ONE never-delivered failure
//            GET  /analytics                       persisted delivery/eligibility metrics
//            GET  /templates/:id/versions          version history
//            GET  /controls                        emergency stop + AI pause state
//            POST /controls/delivery/stop|resume   emergency stop (database switch)
//            POST /controls/ai/pause|resume        AI generation pause
//
// Mounted in server.js behind `authenticate` + `superAdminOnly`, under /api/admin (the
// Admin Dashboard session gate + CSRF on writes), and an owner-only area in
// services/adminAuth/adminPermissions.js — the existing admin architecture, unchanged.
// No route can send a notification, choose a recipient, change the environment switches
// or reveal a credential. Every write is recorded in AuditLog. server.js shuts down on an
// unhandled rejection, so every handler catches everything.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const store = () => require('../services/engagement/templateStore');
const generator = () => require('../services/engagement/ai/generator');
const queries = () => require('../services/engagement/adminQueries');
const controls = () => require('../services/engagement/control');
const { audit } = require('../services/engagement/audit');

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

const limiter = (windowMs, limit, prefix) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `${prefix}:${req.user && req.user._id ? String(req.user._id) : 'anon'}`,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  handler: (_req, res) => fail(res, 429, 'RATE_LIMITED'),
});
const writeLimiter = limiter(60 * 1000, 30, 'admin');
const generateLimiter = limiter(10 * 60 * 1000, 10, 'admin-gen');
const controlLimiter = limiter(60 * 1000, 10, 'admin-ctl');

// The fields an admin sees. Everything is generic copy and metadata; no user data exists here.
const TEMPLATE_FIELDS = ['_id', 'templateId', 'version', 'parentVersion', 'category', 'purpose', 'language', 'tone', 'title', 'body', 'variables',
  'source', 'provider', 'model', 'generationBatchId', 'status', 'approvedAt', 'approvedBy', 'rejectedAt', 'rejectedBy', 'rejectionReason',
  'activatedAt', 'pausedAt', 'archivedAt', 'statusChangedBy', 'createdBy', 'usageCount', 'lastUsedAt', 'performanceMetadata', 'createdAt', 'updatedAt'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));
const templateView = t => pick(t, TEMPLATE_FIELDS);
const auditTemplate = (req, action, t, extra = {}) => audit(req.user, action, 'ENGAGEMENT_TEMPLATE', t && t._id, {
  req, details: t ? { templateId: t.templateId, version: t.version, category: t.category, purpose: t.purpose, language: t.language } : {}, ...extra,
});

router.get('/status', wrap('status')(async (req, res) => {
  const status = await require('../services/engagement/status').getStatus();
  return res.json({ success: true, ...status });
}));

// ── Phase 3: options, monitoring, queue, analytics, controls ─────────────────
router.get('/options', wrap('options')(async (req, res) => {
  const ai = require('../config/engagementAiConfig');
  const eng = require('../config/engagementNotificationConfig');
  const { PURPOSES, VARIABLES } = require('../services/engagement/variables');
  const cfg = ai.get();
  const engCfg = eng.get();
  return res.json({
    success: true,
    categories: eng.CATEGORIES.map(c => ({
      key: c,
      enabledForDelivery: engCfg.enabledCategories.includes(c),
      purposes: Object.entries(PURPOSES[c] || {}).map(([key, p]) => ({ key, description: p.describe, variables: p.vars })),
    })),
    variables: Object.fromEntries(Object.entries(VARIABLES).map(([k, v]) => [k, { description: v.description, sample: v.sample, type: v.type }])),
    languages: ai.LANGUAGES, tones: ai.TONES,
    limits: { maxBatchSize: cfg.maxBatchSize, titleMax: cfg.titleMax, bodyMax: cfg.bodyMax, renderedTitleMax: 65, renderedBodyMax: 180, regenMinHours: cfg.regenMinMs / 3600000 },
    approvalPolicy: cfg.approvalPolicy,
    languageMode: engCfg.languageMode, builtinTemplatesEnabled: engCfg.builtinTemplatesEnabled,
    builtinTemplates: require('../services/engagement/templates').BUILT_IN.map(t => pick(t, ['templateId', 'version', 'category', 'purpose', 'language', 'tone', 'title', 'body'])),
  });
}));

router.get('/monitor', wrap('monitor')(async (req, res) => res.json({ success: true, ...(await queries().monitor()) })));

router.get('/queue', wrap('queue')(async (req, res) => {
  const r = await queries().listQueue(req.query);
  if (!r.ok) return fail(res, 400, r.code, { field: r.field });
  return res.json({ success: true, items: r.items, total: r.total, page: r.page, limit: r.limit });
}));

const REQUEUE_STATUS = { NOT_FOUND: 404, NOT_FAILED: 409, POSSIBLY_DELIVERED: 409, SLOT_NOT_RELEASED: 409, REQUEUE_LIMIT: 409, EVENT_NO_LONGER_RELEVANT: 409, FREQUENCY_LIMIT: 409, CONFLICT: 409 };
router.post('/queue/:id/requeue', writeLimiter, wrap('requeue')(async (req, res) => {
  const r = await queries().requeue(req.params.id, req.user, { req });
  if (!r.ok) return fail(res, REQUEUE_STATUS[r.code] || 400, r.code);
  return res.json({ success: true, item: r.item });
}));

router.get('/analytics', wrap('analytics')(async (req, res) => {
  const r = await queries().analytics(req.query);
  if (!r.ok) return fail(res, 400, r.code);
  const { ok, ...data } = r;
  return res.json({ success: true, ...data });
}));

router.get('/controls', wrap('controls')(async (req, res) => {
  const c = await controls().get();
  return res.json({ success: true, controls: pick(c, ['deliveryStopped', 'deliveryStoppedAt', 'deliveryStoppedBy', 'deliveryStopReason', 'aiPaused', 'aiPausedAt', 'aiPausedBy', 'history', 'updatedAt']) });
}));

// Each switch needs an explicit confirmation word in the body, so a stray request (or a
// replayed CSRF-protected call without it) cannot flip it.
const switchRoute = (which, on, word) => wrap(`control_${which}_${on ? 'on' : 'off'}`)(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.confirm !== word) return fail(res, 400, 'CONFIRMATION_REQUIRED', { expected: word });
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 300)) return fail(res, 400, 'INVALID_REASON');
  const r = await controls().set(which, on, req.user, { reason: body.reason, req });
  if (!r.ok) return fail(res, 409, r.code);
  return res.json({ success: true, controls: pick(r.control, ['deliveryStopped', 'deliveryStoppedAt', 'deliveryStopReason', 'aiPaused', 'aiPausedAt', 'updatedAt']) });
});
router.post('/controls/delivery/stop', controlLimiter, switchRoute('delivery', true, 'STOP'));
router.post('/controls/delivery/resume', controlLimiter, switchRoute('delivery', false, 'RESUME'));
router.post('/controls/ai/pause', controlLimiter, switchRoute('ai', true, 'PAUSE'));
router.post('/controls/ai/resume', controlLimiter, switchRoute('ai', false, 'RESUME'));

// ── Generation ───────────────────────────────────────────────────────────────
router.post('/templates/generate', generateLimiter, wrap('generate')(async (req, res) => {
  const b = await generator().begin(req.body, { trigger: 'MANUAL', requestedBy: adminId(req) });
  if (!b.ok) return fail(res, b.status || 400, b.code, b.field ? { field: b.field } : {});
  await audit(req.user, 'ENGAGEMENT_TEMPLATES_GENERATED', 'ENGAGEMENT_TEMPLATE', b.batch._id, { req, details: b.batch.request });
  // The batch finishes in the background (bounded by provider timeouts); poll its history row.
  generator().run(b.batch).catch(() => { /* run() never throws; belt and braces */ });
  return res.status(202).json({ success: true, batchId: b.batch._id, status: 'RUNNING' });
}));

router.get('/generation-batches', wrap('batches')(async (req, res) => {
  const r = await queries().listBatches(req.query);
  if (!r.ok) return fail(res, 400, r.code, { field: r.field });
  return res.json({ success: true, items: r.items, total: r.total, page: r.page, limit: r.limit });
}));

router.get('/generation-batches/:id', wrap('batch')(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'NOT_FOUND');
  const b = await require('../models/EngagementGenerationBatch').findById(req.params.id).lean();
  if (!b) return fail(res, 404, 'NOT_FOUND');
  return res.json({ success: true, batch: b });
}));

router.get('/ai/providers', wrap('providers')(async (req, res) => {
  const [h, stats] = await Promise.all([require('../services/engagement/ai/notificationAiService').health(), queries().providerStats()]);
  for (const name of Object.keys(h.providers)) h.providers[name].last7Days = stats[name] || { ok: 0, failed: 0, skipped: 0, byOutcome: {} };
  h.paused = !!(await controls().get()).aiPaused;
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

router.get('/templates/:id/versions', wrap('versions')(async (req, res) => {
  const list = await queries().versions(req.params.id);
  if (!list) return fail(res, 404, 'NOT_FOUND');
  return res.json({ success: true, items: list.map(templateView) });
}));

const ACTION_STATUS = { NOT_FOUND: 404, INVALID_TRANSITION: 409, CONFLICT: 409, FAILS_VALIDATION: 422, DUPLICATE: 409, INVALID_REQUEST: 400, UNKNOWN_ACTION: 400 };
const AUDIT_ACTION = { approve: 'ENGAGEMENT_TEMPLATE_APPROVED', reject: 'ENGAGEMENT_TEMPLATE_REJECTED', activate: 'ENGAGEMENT_TEMPLATE_ACTIVATED', pause: 'ENGAGEMENT_TEMPLATE_PAUSED', archive: 'ENGAGEMENT_TEMPLATE_ARCHIVED' };
const lifecycle = action => wrap(action)(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (action === 'reject' && body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 200)) return fail(res, 400, 'INVALID_REASON');
  const r = await store().transition(req.params.id, action, adminId(req), { reason: body.reason });
  if (!r.ok) return fail(res, ACTION_STATUS[r.code] || 400, r.code, { ...(r.status ? { status: r.status } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  await auditTemplate(req, AUDIT_ACTION[action], r.template, { reason: action === 'reject' ? body.reason : null, after: { status: r.template.status } });
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
  await auditTemplate(req, 'ENGAGEMENT_TEMPLATE_REVISED', r.template, { after: { version: r.template.version } });
  return res.status(201).json({ success: true, template: templateView(r.template) });
}));

module.exports = router;
