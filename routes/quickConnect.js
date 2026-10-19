// routes/quickConnect.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 4 backend foundation). Mounted at /api/quick-connect behind
// authenticate and enforceLegalAcceptance in server.js.
//
//   GET  /status              my eligibility (safe reason codes) and consent state
//   POST /consent             { version }  accept the current Quick Connect consent
//   POST /turn-credentials    { sessionId } short-lived TURN credentials, only for a
//                             participant of an active Quick Connect session
//   POST   /waitlist          { fcmToken? } "Notify me" when Quick Connect may have room
//   DELETE /waitlist          cancel it (works while switched off)
//   POST /report              { sessionId, reason, details?, block? } report the other
//                             person of my session (and optionally block them); ends the
//                             session if still open. Works while switched off.
//   DELETE /consent           withdraw my Quick Connect consent: ends my search, proposal or
//                             call at once and removes Notify me, the Smart Discovery opt-in
//                             and open invitations. Works while switched off.
//   PUT  /preferences         { smartDiscovery: boolean, fcmToken? } Smart Discovery opt-in
//                             (on: eligible users only; off: always, also while switched off)
//   GET  /invites/:id         my own invitation's state (no data about who sent it)
//   POST /invites/:id/decline decline my invitation (idempotent; works while switched off)
//   Accepting an invitation is the socket event qc_invite_accept (so the match can reach me).
//
// KILL SWITCH: QUICK_CONNECT_ENABLED (default off). While off, every route except /report
// answers 404 QUICK_CONNECT_DISABLED (the Ask a Question convention) and nothing is issued.
// Ending/cleaning up sessions is server-side and keeps working while off.
//
// The caller is always req.user: no body field can name a user. Responses carry no
// profile data. TURN credentials are never logged and are sent with no-store.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const config = require('../services/quickConnect/config');
const { evaluateEligibility } = require('../services/quickConnect/eligibility');
const sessions = require('../services/quickConnect/sessions');
const { mintTurnCredentials } = require('../services/quickConnect/turnCredentials');
const QuickConnectConsent = require('../models/QuickConnectConsent');
const reports = require('../services/quickConnect/reports');
const capacity = require('../services/quickConnect/capacity');
const waitlist = require('../services/quickConnect/waitlist');
const User = require('../models/User');
const discovery = require('../services/quickConnect/discovery');
const consentService = require('../services/quickConnect/consent');
const { DASHBOARD_SCOPE } = require('../utils/sessionGuard');

const router = express.Router();

const STATUS_FOR_CODE = {
  QUICK_CONNECT_DISABLED: 404,
  ACCOUNT_INVALID: 401,
  ACCOUNT_RESTRICTED: 403,
  SESSION_NOT_ALLOWED: 403,
  AGE_NOT_ASSURED: 403,
  NOT_IN_BETA: 403,
  VERIFICATION_REQUIRED: 403,
  CONSENT_REQUIRED: 403,
  BUSY: 409,
  SESSION_NOT_FOUND: 404,
  REPORT_WINDOW_CLOSED: 410,
  INVITE_NOT_FOUND: 404
};
const MESSAGE_FOR_CODE = {
  QUICK_CONNECT_DISABLED: 'Quick Connect is not available.',
  ACCOUNT_INVALID: 'Authentication required.',
  ACCOUNT_RESTRICTED: 'Quick Connect is not available for this account.',
  SESSION_NOT_ALLOWED: 'Quick Connect is only available in the app.',
  AGE_NOT_ASSURED: 'Quick Connect is only available to verified adults.',
  NOT_IN_BETA: 'Quick Connect is not available for your account yet.',
  VERIFICATION_REQUIRED: 'Complete verification to use Quick Connect.',
  CONSENT_REQUIRED: 'Please review and accept the Quick Connect terms.',
  BUSY: 'You are already in a call.',
  SESSION_NOT_FOUND: 'This call could not be found.',
  REPORT_WINDOW_CLOSED: 'This call is too old to report here. Please contact support.',
  INVITE_NOT_FOUND: 'This invitation could not be found.'
};

const fail = (res, code, extra = {}) =>
  res.status(STATUS_FOR_CODE[code] || 400).json({ success: false, code, message: MESSAGE_FOR_CODE[code] || 'Invalid request.', ...extra });
const invalid = res => res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: 'Invalid request.' });
const isPlainBody = b => b && typeof b === 'object' && !Array.isArray(b);
/** photoVerificationStatus (authoritative) → the app's words: unverified | pending | approved | rejected. */
const verificationState = s => (s === 'approved' || s === 'pending' || s === 'rejected') ? s : 'unverified';

const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[quick-connect] ${req.method} ${req.baseUrl}${req.route ? req.route.path : ''}:`, err && err.name);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  }
};

const perUser = (max, windowMs = 60 * 1000) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `qc:${String(req.userId || (req.user && req.user._id) || 'anon')}`,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  handler: (req, res) => res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' })
});

router.use((req, res, next) => {
  if (!req.user || !req.user._id) return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
  // Ending and opting out always work, also while switched off.
  const cleanup = req.path === '/report' || (req.path === '/waitlist' && req.method === 'DELETE') ||
    (req.path === '/consent' && req.method === 'DELETE') ||
    (req.path === '/preferences' && req.method === 'PUT' && req.body && req.body.smartDiscovery === false) ||
    (req.method === 'POST' && /^\/invites\/[^/]+\/decline$/.test(req.path));
  if (!config.isEnabled() && !cleanup) return fail(res, 'QUICK_CONNECT_DISABLED');   // reports and cancels always work
  res.set('Cache-Control', 'no-store');
  return next();
});

// GET /status — the caller's own eligibility. Reason codes only; no profile fields.
router.get('/status', perUser(60), handle(async (req, res) => {
  const e = await evaluateEligibility(req.user._id, { auth: req.auth });
  if (e.code === 'QUICK_CONNECT_DISABLED' || e.code === 'ACCOUNT_INVALID') return fail(res, e.code);
  const [me, busy, waitlisted, pref] = await Promise.all([
    User.findById(req.user._id).select('photoVerificationStatus').lean(),
    capacity.isFull(),
    waitlist.isWaiting(req.user._id),
    discovery.getPreference(req.user._id)
  ]);
  return res.json({
    success: true, enabled: true, eligible: e.eligible, reasons: e.reasons, consent: e.consent,
    verification: verificationState(me && me.photoVerificationStatus),   // the caller's own state only
    busy,                                                            // all capacity slots taken
    waitlisted,
    smartDiscovery: { available: config.smartDiscoveryEnabled(), optedIn: pref.optedIn, push: pref.push }
  });
}));

// POST /consent { version } — records acceptance of the CURRENT version for req.user.
// Idempotent: accepting again returns the original acceptance time.
router.post('/consent', perUser(10), handle(async (req, res) => {
  if (req.auth && req.auth.scope === DASHBOARD_SCOPE) return fail(res, 'SESSION_NOT_ALLOWED');
  const required = config.requiredConsentVersion();
  if (!required) return res.status(503).json({ success: false, code: 'CONSENT_UNAVAILABLE', message: 'Quick Connect is not available right now.' });

  const body = req.body;
  if (!isPlainBody(body) || typeof body.version !== 'string' || body.version.length === 0 || body.version.length > 32) return invalid(res);
  if (body.version !== required) {
    return res.status(409).json({ success: false, code: 'CONSENT_VERSION_MISMATCH', message: 'These terms have been updated. Please review them again.', requiredVersion: required });
  }

  const filter = { userId: req.user._id, version: required };
  let record;
  let created = false;
  try {
    const r = await QuickConnectConsent.findOneAndUpdate(
      filter,
      { $setOnInsert: { acceptedAt: new Date() } },
      { upsert: true, new: true, includeResultMetadata: true }
    );
    record = r.value;
    created = !(r.lastErrorObject && r.lastErrorObject.updatedExisting);
  } catch (err) {
    if (err && err.code === 11000) record = await QuickConnectConsent.findOne(filter).lean();   // a simultaneous request won
    else throw err;
  }
  if (!record) throw new Error('consent not recorded');
  return res.status(created ? 201 : 200).json({
    success: true,
    alreadyAccepted: !created,
    consent: { version: record.version, acceptedAt: new Date(record.acceptedAt).toISOString() }
  });
}));

// DELETE /consent — withdraw consent. Takes effect at once (see services/quickConnect/consent.js).
router.delete('/consent', perUser(10), handle(async (req, res) => {
  const r = await consentService.withdraw(req.user._id);
  return res.json({ success: true, withdrawn: r.withdrawn, ended: r.ended });
}));

// PUT /preferences { smartDiscovery, fcmToken? } — the Smart Discovery opt-in.
router.put('/preferences', perUser(10), handle(async (req, res) => {
  if (req.auth && req.auth.scope === DASHBOARD_SCOPE) return fail(res, 'SESSION_NOT_ALLOWED');
  const body = req.body;
  if (!isPlainBody(body) || typeof body.smartDiscovery !== 'boolean') return invalid(res);
  if (body.fcmToken !== undefined && body.fcmToken !== null && typeof body.fcmToken !== 'string') return invalid(res);
  const r = await discovery.setPreference(req.user._id, { smartDiscovery: body.smartDiscovery, fcmToken: body.fcmToken, auth: req.auth });
  if (!r.ok) return fail(res, r.code);
  return res.json({ success: true, smartDiscovery: { available: config.smartDiscoveryEnabled(), optedIn: r.optedIn, push: r.push } });
}));

// GET /invites/:id — the recipient's own invitation; anyone else gets 404.
router.get('/invites/:id', perUser(30), handle(async (req, res) => {
  const r = await discovery.getInvite(req.user._id, req.params.id);
  if (!r.ok) return r.code === 'INVALID_REQUEST' ? invalid(res) : fail(res, r.code);
  return res.json({ success: true, invite: r.invite });
}));

// POST /invites/:id/decline — idempotent.
router.post('/invites/:id/decline', perUser(20), handle(async (req, res) => {
  const r = await discovery.declineInvite(req.user._id, req.params.id);
  if (!r.ok) return r.code === 'INVALID_REQUEST' ? invalid(res) : fail(res, r.code);
  return res.json({ success: true, alreadyAnswered: r.alreadyAnswered });
}));

// POST /turn-credentials { sessionId } — only for a participant of an ACTIVE session.
router.post('/turn-credentials', perUser(20), handle(async (req, res) => {
  const body = req.body;
  if (!isPlainBody(body) || typeof body.sessionId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(body.sessionId) ||
      !mongoose.isValidObjectId(body.sessionId)) return invalid(res);

  // Membership first: a session the caller is not an active participant of does not exist
  // for them (404) — whatever their eligibility. Then the full policy, where the caller's
  // own session does not count as "busy".
  const session = await sessions.findActiveSessionFor(body.sessionId, req.user._id);
  if (!session) return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', message: 'This call is no longer active.' });

  const e = await evaluateEligibility(req.user._id, { auth: req.auth, ownSessionId: String(session._id) });
  if (!e.eligible) return fail(res, e.code);

  const turn = config.turnConfig();
  if (!turn) {
    console.error('[quick-connect] TURN is not configured (TURN_SHARED_SECRET missing or invalid)');
    return res.status(503).json({ success: false, code: 'TURN_UNAVAILABLE', message: 'Quick Connect is not available right now.' });
  }
  const c = mintTurnCredentials(turn);
  return res.json({
    success: true,
    iceServers: [{ urls: c.uris, username: c.username, credential: c.credential }],
    ttlSeconds: c.ttlSeconds,
    expiresAt: c.expiresAt
  });
}));

router.post('/waitlist', perUser(10), handle(async (req, res) => {
  if (req.auth && req.auth.scope === DASHBOARD_SCOPE) return fail(res, 'SESSION_NOT_ALLOWED');
  const body = req.body === undefined ? {} : req.body;
  if (!isPlainBody(body)) return invalid(res);
  if (body.fcmToken !== undefined && body.fcmToken !== null && typeof body.fcmToken !== 'string') return invalid(res);
  const r = await waitlist.join(req.user._id, { fcmToken: body.fcmToken, auth: req.auth });
  if (!r.ok) return fail(res, r.code);
  return res.status(r.alreadyWaiting ? 200 : 201).json({ success: true, waiting: true, push: r.push });
}));

router.delete('/waitlist', perUser(20), handle(async (req, res) => {
  const r = await waitlist.leave(req.user._id);
  return res.json({ success: true, removed: r.removed });
}));

router.post('/report', perUser(10), handle(async (req, res) => {
  if (req.auth && req.auth.scope === DASHBOARD_SCOPE) return fail(res, 'SESSION_NOT_ALLOWED');
  const r = await reports.reportPeer(req.user._id, req.body);
  if (!r.ok) return r.code === 'INVALID_REQUEST' ? invalid(res) : fail(res, r.code);
  return res.status(r.alreadyReported ? 200 : 201).json({ success: true, alreadyReported: r.alreadyReported, blocked: r.blocked, ended: r.ended });
}));

module.exports = router;
