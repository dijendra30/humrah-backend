// routes/adminQuestions.js
// -----------------------------------------------------------------------------
// Ask a Question — admin API (Phase 2B). Mounted at /api/admin/questions behind
// authenticate + adminOnly in server.js; each route also checks one permission
// (services/questions/questionAdminPermissions.js). Not reachable from user routes.
// Every action needs a reason and is written to the existing AuditLog.
//
//   GET  /me/permissions                         what this admin may do (for the UI)
//   GET  /stats?range=today|7d|30d|90d|all       KPIs, analytics, categories, reports, moderation, health
//   GET  /activity                               recent question activity
//   GET  /export.csv?…filters                    CSV (no coordinates / personal data)
//   GET  /                                       questions: search, filters, sort, pages
//   GET  /reports  ·  GET /reports/:id  ·  POST /reports/:id/status  ·  POST /reports/:id/escalate
//   GET  /moderation  ·  GET /moderation/:id  ·  POST /moderation/:id/decision
//   GET  /restrictions  ·  POST /restrictions/:userId/apply  ·  POST /restrictions/:userId/remove
//   GET  /users/:userId/history
//   POST /answers/:answerId/hide  ·  POST /answers/:answerId/restore
//   GET  /:questionId  ·  POST /:questionId/hide|restore|close|delete|review
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const admin = require('../services/questions/questionAdminService');
const { PERMS, permissionsOf, requireQuestionPermission: need } = require('../services/questions/questionAdminPermissions');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user || !req.user._id) return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
  return next();
});

function send(res, result) {
  const { status = 200, ...body } = result;
  return res.status(status).json(body);
}
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[admin-questions] ${req.method} ${req.route ? req.route.path : ''}:`, err && err.name, err && err.message);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong.' });
  }
};
const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const q = req => req.query || {};

router.get('/me/permissions', handle(async (req, res) => send(res, { status: 200, success: true, role: req.user.role, permissions: permissionsOf(req.user) })));
router.get('/stats', need(PERMS.VIEW_ANALYTICS), handle(async (req, res) => send(res, await admin.stats(q(req)))));
router.get('/activity', need(PERMS.VIEW_QUESTIONS), handle(async (req, res) => send(res, await admin.recentActivity(q(req)))));
router.get('/export.csv', need(PERMS.EXPORT_DATA), handle(async (req, res) => {
  const r = await admin.exportQuestionsCsv(req.user, q(req), req);
  if (!r.success) return send(res, r);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="humrah-questions-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.status(200).send(r.csv);
}));
router.get('/', need(PERMS.VIEW_QUESTIONS), handle(async (req, res) => send(res, await admin.listQuestions(q(req)))));

router.get('/reports', need(PERMS.REVIEW_REPORTS), handle(async (req, res) => send(res, await admin.listReports(q(req)))));
router.get('/reports/:reportId', need(PERMS.REVIEW_REPORTS), handle(async (req, res) => send(res, await admin.reportDetail(req.params.reportId))));
router.post('/reports/:reportId/status', need(PERMS.REVIEW_REPORTS), handle(async (req, res) => send(res, await admin.setReportStatus(req.user, req.params.reportId, body(req), req))));
router.post('/reports/:reportId/escalate', need(PERMS.REVIEW_REPORTS), handle(async (req, res) => send(res, await admin.escalateReport(req.user, req.params.reportId, body(req), req))));

router.get('/moderation', need(PERMS.MODERATE_CONTENT), handle(async (req, res) => send(res, await admin.listModeration(q(req)))));
router.get('/moderation/:recordId', need(PERMS.MODERATE_CONTENT), handle(async (req, res) => send(res, await admin.moderationRecordDetail(req.params.recordId))));
router.post('/moderation/:recordId/decision', need(PERMS.MODERATE_CONTENT), handle(async (req, res) => send(res, await admin.decideModerationRecord(req.user, req.params.recordId, body(req), req))));

router.get('/restrictions', need(PERMS.VIEW_QUESTIONS), handle(async (req, res) => send(res, await admin.listRestrictions(q(req)))));
router.post('/restrictions/:userId/apply', need(PERMS.APPLY_RESTRICTIONS), handle(async (req, res) => send(res, await admin.applyRestriction(req.user, req.params.userId, body(req), req))));
router.post('/restrictions/:userId/remove', need(PERMS.APPLY_RESTRICTIONS), handle(async (req, res) => send(res, await admin.removeRestriction(req.user, req.params.userId, body(req), req))));

router.get('/users/:userId/history', need(PERMS.VIEW_QUESTIONS), handle(async (req, res) => send(res, await admin.userHistory(req.params.userId))));

router.post('/answers/:answerId/hide', need(PERMS.HIDE_CONTENT), handle(async (req, res) => send(res, await admin.hideAnswer(req.user, req.params.answerId, body(req), req))));
router.post('/answers/:answerId/restore', need(PERMS.HIDE_CONTENT), handle(async (req, res) => send(res, await admin.restoreAnswer(req.user, req.params.answerId, body(req), req))));

router.get('/:questionId', need(PERMS.VIEW_QUESTIONS), handle(async (req, res) => send(res, await admin.questionDetail(req.params.questionId))));
router.post('/:questionId/hide', need(PERMS.HIDE_CONTENT), handle(async (req, res) => send(res, await admin.hideQuestion(req.user, req.params.questionId, body(req), req))));
router.post('/:questionId/restore', need(PERMS.HIDE_CONTENT), handle(async (req, res) => send(res, await admin.restoreQuestion(req.user, req.params.questionId, body(req), req))));
router.post('/:questionId/close', need(PERMS.HIDE_CONTENT), handle(async (req, res) => send(res, await admin.closeQuestion(req.user, req.params.questionId, body(req), req))));
router.post('/:questionId/delete', need(PERMS.DELETE_CONTENT), handle(async (req, res) => send(res, await admin.deleteQuestion(req.user, req.params.questionId, body(req), req))));
router.post('/:questionId/review', need(PERMS.MODERATE_CONTENT), handle(async (req, res) => send(res, await admin.markQuestionReviewed(req.user, req.params.questionId, body(req), req))));

module.exports = router;
