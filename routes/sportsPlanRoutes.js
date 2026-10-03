// routes/sportsPlanRoutes.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 1A REST API.
//
// Mounted in server.js as:
//   app.use('/api/sports-plans', authenticate, enforceLegalAcceptance, sportsPlanRoutes)
// the same middleware every other feature router gets, so req.user / req.userId
// are always the authenticated caller. Nothing here reads a user id from the body.
//
//   POST /api/sports-plans              create
//   GET  /api/sports-plans/nearby       discover
//   GET  /api/sports-plans/:id          view
//   POST /api/sports-plans/:id/join     join      → socket plan_joined
//   POST /api/sports-plans/:id/leave    leave     → socket plan_left
//   POST /api/sports-plans/:id/cancel   cancel    → socket plan_cancelled
//
// Phase 2A — Sports Sessions (services/sportsSessionService.js):
//   GET  /api/sports-plans/sessions             the caller's sessions (Messages → Sessions)
//   GET  /api/sports-plans/sessions/:sessionId  one session, members only
//   join / leave / cancel also emit session_participant_joined /
//   session_participant_left / session_cancelled to the plan's members.
//
// Phase 3 — Sports group chat (services/sportsChatService.js), members only:
//   GET    /api/sports-plans/sessions/:sessionId/messages?before=&limit=   history, newest first
//   POST   /api/sports-plans/sessions/:sessionId/messages                  send → sports_message_created
//   POST   /api/sports-plans/sessions/:sessionId/read                      mark read (not activity)
//   POST   /api/sports-plans/sessions/:sessionId/messages/:messageId/reaction   { emoji }
//   DELETE /api/sports-plans/sessions/:sessionId/messages/:messageId/reaction
//   The sender is always req.user; nothing in a body names a user.
//
// Chat enhancement (same services; author and host come from the database):
//   PATCH  /sessions/:sessionId/messages/:messageId              edit { text } (author, 15 min)
//   DELETE /sessions/:sessionId/messages/:messageId              delete for everyone (author or host)
//   POST   /sessions/:sessionId/messages/:messageId/hide         delete for me
//   POST   /sessions/:sessionId/messages/:messageId/link-check   { url } → SAFE | UNSAFE | UNKNOWN
//   POST   /sessions/:sessionId/members/:userId/remove           host removes a player
//   POST   /sessions/:sessionId/attendance                       { answer: 'YES' | 'NO' }
//   POST /sessions/:sessionId/messages also takes replyToMessageId; GET …/messages takes &until=.
//
// Responses follow the { success, code, message } shape used by the Surprise
// Activity and Movie Hangout routes.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const router  = express.Router();

const svc = require('../services/sportsPlanService');
const sessionSvc = require('../services/sportsSessionService');
const chatSvc = require('../services/sportsChatService');
const attendanceSvc = require('../services/sportsAttendanceService');
const redisService = require('../services/redisService');
const {
  emitPlanJoined,
  emitPlanLeft,
  emitPlanCancelled,
  evictUserFromPlanRoom,
  emitSessionParticipantJoined,
  emitSessionParticipantLeft,
  emitSessionCancelled,
  emitSessionParticipantRemoved,
} = require('../sockets/sportsSocket');

// Belt-and-braces. Authentication is applied where this router is mounted; this
// refuses the request instead of failing obscurely if it is ever mounted without it.
router.use((req, res, next) => {
  if (!req.user || !req.user._id) {
    return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
  }
  return next();
});

/** Writes a service result. `status` is transport, not payload. */
function send(res, result) {
  const { status = 200, ...body } = result;
  return res.status(status).json(body);
}

/** Any unexpected error becomes a generic 500. Internal messages never reach the client. */
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[sports-plans] ${req.method} ${req.originalUrl}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
    }
  }
};

// ── CREATE ─────────────────────────────────────────────────────────────────────
router.post('/', handle(async (req, res) => {
  send(res, await svc.createPlan(req.user, req.body));
}));

// ── NEARBY — declared before /:id so "nearby" is never read as an id ───────────
router.get('/nearby', handle(async (req, res) => {
  send(res, await svc.getNearbyPlans(req.user, req.query));
}));

// ── SESSIONS (Phase 2A) — declared before /:id, like /nearby ───────────────────
router.get('/sessions', handle(async (req, res) => {
  send(res, await sessionSvc.listMySessions(req.user));
}));

router.get('/sessions/:sessionId', handle(async (req, res) => {
  send(res, await sessionSvc.getSession(req.user, req.params.sessionId));
}));

// ── CHAT (Phase 3) ─────────────────────────────────────────────────────────────

/**
 * A per-user fixed window, the way Humrah Rooms limits its actions. Fails open if
 * the counter store errors, so an outage never blocks the chat.
 */
function perUserLimit(action, max, windowSeconds, message) {
  return async (req, res, next) => {
    try {
      const count = await redisService.incrementWithWindow(`ratelimit:sports:${action}:${req.user._id}`, windowSeconds);
      if (count > max) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message });
    } catch (err) {
      console.error(`[sports-plans] ${action} rate limit failed open:`, err.message);
    }
    return next();
  };
}
const messageLimiter  = perUserLimit('message', 30, 60, 'You are sending messages too fast. Please slow down.');
const reactionLimiter = perUserLimit('reaction', 60, 60, 'Too many reactions at once. Please slow down.');
const editLimiter     = perUserLimit('edit', 20, 60, 'You are editing too fast. Please slow down.');
const deleteLimiter   = perUserLimit('delete', 30, 60, 'You are deleting too fast. Please slow down.');
const hideLimiter     = perUserLimit('hide', 60, 60, 'Too many at once. Please slow down.');
const removeLimiter   = perUserLimit('remove', 10, 60, 'Too many removals at once. Please wait a moment.');
const voteLimiter     = perUserLimit('vote', 20, 60, 'Too many answers at once. Please wait a moment.');
const linkLimiter     = perUserLimit('linkcheck', 30, 60, 'Too many links checked at once. Please wait a moment.');

router.get('/sessions/:sessionId/messages', handle(async (req, res) => {
  send(res, await chatSvc.listMessages(req.user, req.params.sessionId, req.query));
}));

router.post('/sessions/:sessionId/messages', messageLimiter, handle(async (req, res) => {
  send(res, await chatSvc.sendMessage(req.user, req.params.sessionId, req.body || {}));
}));

router.post('/sessions/:sessionId/read', handle(async (req, res) => {
  send(res, await chatSvc.markRead(req.user, req.params.sessionId));
}));

router.post('/sessions/:sessionId/messages/:messageId/reaction', reactionLimiter, handle(async (req, res) => {
  send(res, await chatSvc.setReaction(req.user, req.params.sessionId, req.params.messageId, req.body && req.body.emoji));
}));

router.delete('/sessions/:sessionId/messages/:messageId/reaction', reactionLimiter, handle(async (req, res) => {
  send(res, await chatSvc.setReaction(req.user, req.params.sessionId, req.params.messageId, null, { remove: true }));
}));

// ── CHAT ENHANCEMENT ───────────────────────────────────────────────────────────

router.patch('/sessions/:sessionId/messages/:messageId', editLimiter, handle(async (req, res) => {
  send(res, await chatSvc.editMessage(req.user, req.params.sessionId, req.params.messageId, req.body || {}));
}));

router.delete('/sessions/:sessionId/messages/:messageId', deleteLimiter, handle(async (req, res) => {
  send(res, await chatSvc.deleteForEveryone(req.user, req.params.sessionId, req.params.messageId));
}));

router.post('/sessions/:sessionId/messages/:messageId/hide', hideLimiter, handle(async (req, res) => {
  send(res, await chatSvc.hideMessage(req.user, req.params.sessionId, req.params.messageId));
}));

router.post('/sessions/:sessionId/messages/:messageId/link-check', linkLimiter, handle(async (req, res) => {
  send(res, await chatSvc.checkMessageLink(req.user, req.params.sessionId, req.params.messageId, req.body || {}));
}));

// "Delete" a finished session from the caller's own Messages → Sessions list. Per user
// only: nothing shared changes (sportsSessionService.hideSession).
router.post('/sessions/:sessionId/hide', hideLimiter, handle(async (req, res) => {
  send(res, await sessionSvc.hideSession(req.user, req.params.sessionId));
}));

router.post('/sessions/:sessionId/members/:userId/remove', removeLimiter, handle(async (req, res) => {
  const result = await sessionSvc.removeMember(req.user, req.params.sessionId, req.params.userId);
  if (result.success) {
    const io = req.app.get('io');
    emitPlanLeft(io, result.plan, { _id: result.userId, firstName: null });
    emitSessionParticipantRemoved(io, result.session, result.plan, result.userId);
  }
  send(res, result);
}));

router.post('/sessions/:sessionId/attendance', voteLimiter, handle(async (req, res) => {
  send(res, await attendanceSvc.castVote(req.user, req.params.sessionId, req.body || {}));
}));

// ── GET ────────────────────────────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  send(res, await svc.getPlan(req.user, req.params.id));
}));

// ── JOIN ───────────────────────────────────────────────────────────────────────
router.post('/:id/join', handle(async (req, res) => {
  const result = await svc.joinPlan(req.user, req.params.id);
  if (result.success) {
    const io = req.app.get('io');
    emitPlanJoined(io, result.plan, req.user);
    emitSessionParticipantJoined(io, result.session, result.plan, req.user);
  }
  send(res, result);
}));

// ── LEAVE ──────────────────────────────────────────────────────────────────────
router.post('/:id/leave', handle(async (req, res) => {
  const result = await svc.leavePlan(req.user, req.params.id);
  if (result.success) {
    const io = req.app.get('io');
    emitPlanLeft(io, result.plan, req.user);
    emitSessionParticipantLeft(io, result.session, result.plan, req.user);
    // A former participant stops receiving the plan's events straight away.
    evictUserFromPlanRoom(io, result.plan.id, req.user._id);
  }
  send(res, result);
}));

// ── CANCEL ─────────────────────────────────────────────────────────────────────
router.post('/:id/cancel', handle(async (req, res) => {
  const result = await svc.cancelPlan(req.user, req.params.id);
  if (result.success) {
    const io = req.app.get('io');
    emitPlanCancelled(io, result.plan);
    emitSessionCancelled(io, result.session, result.plan);
  }
  send(res, result);
}));

module.exports = router;
