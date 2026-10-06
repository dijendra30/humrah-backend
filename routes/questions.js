// routes/questions.js
// -----------------------------------------------------------------------------
// Ask a Question (Phase 2). Mounted at /api/questions behind authenticate and
// enforceLegalAcceptance in server.js. Rules live in services/questionService.js.
//
//   GET    /config                                    categories, tags, limits, enabled
//   GET    /mine/restriction                          my question-creation status
//   GET    /nearby?home=1 | ?page=&limit=             Questions Near You (Home: max 3)
//   POST   /                                          ask (Idempotency-Key header or clientRequestId)
//   POST   /reports                                   report a question / answer / reply
//   GET    /:questionId                               detail
//   POST   /:questionId/close                         owner: close (no reopening)
//   DELETE /:questionId                               owner: soft delete
//   POST   /:questionId/hide                          hide from my discovery
//   GET    /:questionId/answers?after=&limit=         answers (oldest first) with replies
//   POST   /:questionId/answers                       answer
//   DELETE /:questionId/answers/:answerId             delete my answer (soft)
//   POST   /:questionId/answers/:answerId/replies     reply (asker or that answer's author)
//
// The caller is always req.user; no body field names an owner, asker or author.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const svc = require('../services/questionService');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user || !req.user._id) {
    return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
  }
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
    console.error(`[questions] ${req.method} ${req.baseUrl}${req.route ? req.route.path : ''}:`, err && err.name);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  }
};
const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

router.get('/config', handle(async (req, res) => send(res, svc.getConfig())));
router.get('/mine/restriction', handle(async (req, res) => send(res, await svc.myRestriction(req.user))));
// Phase 6 Replier Level: the viewer's own level, points and history (before /:questionId).
router.get('/mine/reputation', handle(async (req, res) => send(res, await svc.myReputation(req.user, req.query || {}))));
router.get('/nearby', handle(async (req, res) => send(res, await svc.nearbyQuestions(req.user, req.query || {}))));
router.post('/', handle(async (req, res) => send(res, await svc.createQuestion(req.user, body(req), { idempotencyKey: req.get('Idempotency-Key') }))));
router.post('/reports', handle(async (req, res) => send(res, await svc.reportContent(req.user, body(req)))));

router.get('/:questionId', handle(async (req, res) => send(res, await svc.getQuestion(req.user, req.params.questionId))));
router.post('/:questionId/close', handle(async (req, res) => send(res, await svc.closeQuestion(req.user, req.params.questionId))));
router.delete('/:questionId', handle(async (req, res) => send(res, await svc.deleteQuestion(req.user, req.params.questionId))));
router.post('/:questionId/hide', handle(async (req, res) => send(res, await svc.hideQuestion(req.user, req.params.questionId))));
router.get('/:questionId/answers', handle(async (req, res) => send(res, await svc.listAnswers(req.user, req.params.questionId, req.query || {}))));
router.post('/:questionId/answers', handle(async (req, res) => send(res, await svc.createAnswer(req.user, req.params.questionId, body(req)))));
router.delete('/:questionId/answers/:answerId', handle(async (req, res) => send(res, await svc.deleteAnswer(req.user, req.params.questionId, req.params.answerId))));
// Phase 6: the asker's authoritative "✓ Helpful" (+15 to the answer's author, once).
router.post('/:questionId/answers/:answerId/helpful', handle(async (req, res) => send(res, await svc.markHelpful(req.user, req.params.questionId, req.params.answerId))));
router.post('/:questionId/answers/:answerId/replies', handle(async (req, res) => send(res, await svc.createReply(req.user, req.params.questionId, req.params.answerId, body(req)))));

module.exports = router;
