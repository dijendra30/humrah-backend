// routes/adminQuestions.js
// -----------------------------------------------------------------------------
// Ask a Question — explicit Safety actions. Mounted at /api/admin/questions behind
// authenticate + adminOnly (the existing admin roles) in server.js. Every action is
// recorded (QuestionAuditLog, and the restriction's own history) with the admin's id.
// Account-level enforcement stays in the existing admin moderation tools.
//
//   GET  /reports?status=OPEN                     the report queue
//   GET  /restrictions/:userId                    a person's question-creation restriction
//   POST /restrictions/:userId/lift  { note, reset? }   lift it (reset: back to level 0)
//   POST /:questionId/hide  { reason }            hide a question for everyone (reviewable)
//   POST /:questionId/unhide                      undo that
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const svc = require('../services/questionService');

const router = express.Router();

function send(res, result) {
  const { status = 200, ...body } = result;
  return res.status(status).json(body);
}
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[admin-questions] ${req.method}:`, err && err.name);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong.' });
  }
};
const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

router.get('/reports', handle(async (req, res) => send(res, await svc.adminListReports(req.query || {}))));
router.get('/restrictions/:userId', handle(async (req, res) => send(res, await svc.adminGetRestriction(req.params.userId))));
router.post('/restrictions/:userId/lift', handle(async (req, res) => send(res, await svc.adminLiftRestriction(req.user, req.params.userId, { note: body(req).note, reset: body(req).reset === true }))));
router.post('/:questionId/hide', handle(async (req, res) => send(res, await svc.adminSetHidden(req.user, req.params.questionId, true, body(req).reason))));
router.post('/:questionId/unhide', handle(async (req, res) => send(res, await svc.adminSetHidden(req.user, req.params.questionId, false))));

module.exports = router;
