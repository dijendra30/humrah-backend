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
// Responses follow the { success, code, message } shape used by the Surprise
// Activity and Movie Hangout routes.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const router  = express.Router();

const svc = require('../services/sportsPlanService');
const sessionSvc = require('../services/sportsSessionService');
const {
  emitPlanJoined,
  emitPlanLeft,
  emitPlanCancelled,
  evictUserFromPlanRoom,
  emitSessionParticipantJoined,
  emitSessionParticipantLeft,
  emitSessionCancelled,
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
