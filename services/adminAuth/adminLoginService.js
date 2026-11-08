// services/adminAuth/adminLoginService.js — request / resend / verify an Admin Dashboard code.
// Returns plain { status, body } results; the route only translates them to HTTP.
'use strict';

const config = require('../../config/adminAuthConfig');
const AdminLoginChallenge = require('../../models/AdminLoginChallenge');
const { generateOtp, randomToken, hashOtp, safeEqualHex, requestMeta } = require('./adminAuthCrypto');
const identity = require('./adminIdentity');
const rateLimit = require('./adminAuthRateLimit');
const mailer = require('./adminOtpMailer');
const securityLog = require('./adminSecurityLog');
const sessions = require('./adminSessionService');

const GENERIC_SENT = 'If this email belongs to an authorised administrator, a verification code has been sent to the Humrah support mailbox.';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{20,64}$/;
const OTP_RE = /^\d{6}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Decoy paths wait about as long as a real email send so timing says little. */
const decoyDelay = () => sleep(250 + Math.floor(Math.random() * 500)); // timing jitter only, not security-relevant

const fail = (status, code, message, extra = {}) => ({ status, body: { success: false, code, message, ...extra } });

function parseEmail(v) {
  if (typeof v !== 'string' || v.length > 254) return null;
  const e = config.normEmail(v);
  return config.EMAIL_RE.test(e) ? e : null;
}

async function ipLimit(req, scope, max) {
  const meta = requestMeta(req);
  return rateLimit.hit(scope, meta.ip || 'unknown', { max, windowMs: config.get().ipWindowMs });
}

function rateLimited(req, email, authorised, retryAfterSeconds, reason) {
  securityLog.record('OTP_RATE_LIMITED', req, { email, authorised, details: { reason, retryAfterSeconds } });
  return fail(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.', { retryAfterSeconds });
}

/** Keeps exactly one PENDING challenge per email: the most recently issued one. */
async function supersedeOlder(email) {
  const newest = await AdminLoginChallenge.findOne({ email, status: 'PENDING' }).sort({ otpIssuedAt: -1, _id: -1 }).select('_id').lean();
  if (!newest) return;
  await AdminLoginChallenge.updateMany(
    { email, status: 'PENDING', _id: { $ne: newest._id } },
    { $set: { status: 'SUPERSEDED', closedAt: new Date() } },
  );
}

async function deliver(req, challenge, otp, user, kind) {
  if (!user) { await decoyDelay(); return { ok: true }; }
  const sent = await mailer.sendAdminOtp({ otp, adminEmail: user.email, requestedAt: challenge.otpIssuedAt });
  if (!sent.ok) {
    await AdminLoginChallenge.updateOne({ _id: challenge._id, status: 'PENDING' }, { $set: { status: 'DELIVERY_FAILED', closedAt: new Date() } });
    securityLog.record('OTP_DELIVERY_FAILED', req, { email: user.email, authorised: true, userId: user._id, details: { provider: sent.provider, reason: sent.reason } });
    return { ok: false };
  }
  securityLog.record(kind === 'resend' ? 'OTP_RESENT' : 'OTP_DELIVERED', req, { email: user.email, authorised: true, userId: user._id, details: { provider: sent.provider, sendCount: challenge.sendCount } });
  return { ok: true };
}

const deliveryFailed = () => fail(503, 'OTP_DELIVERY_FAILED', 'We could not send the verification code right now. Please try again in a few minutes.');

// ─────────────────────────────────────────────────────────────────────────────
async function requestOtp(req, body) {
  const cfg = config.get();
  if (!cfg.enabled) return fail(503, 'ADMIN_AUTH_NOT_CONFIGURED', 'Admin sign-in is not available right now.');

  const email = parseEmail(body && body.email);
  if (!email) return fail(400, 'INVALID_EMAIL', 'Enter a valid email address.');

  const ip = await ipLimit(req, 'admin-otp-request-ip', cfg.ipMaxOtpRequests);
  if (!ip.allowed) return rateLimited(req, email, false, ip.retryAfterSeconds, 'ip');

  const user = await identity.findEligibleAdmin(email);
  const authorised = !!user;

  const id = await rateLimit.hit('admin-otp-send-identity', email, { max: cfg.identityMaxSends, windowMs: cfg.identityWindowMs });
  if (!id.allowed) return rateLimited(req, email, authorised, id.retryAfterSeconds, 'identity');

  const now = new Date();
  const challengeId = randomToken(24);
  const otp = authorised ? generateOtp(cfg.otpLength) : null;
  const challenge = await AdminLoginChallenge.create({
    challengeId,
    email,
    userId: authorised ? user._id : null,
    // a decoy gets the hash of a random value nobody knows, so it can never verify
    otpHash: hashOtp(challengeId, 1, otp || randomToken(16)),
    otpIssuedAt: now,
    lastSentAt: now,
    sendCount: 1,
    expiresAt: new Date(now.getTime() + cfg.otpTtlMs),
    ipHash: requestMeta(req).ipHash,
    purgeAt: new Date(now.getTime() + cfg.otpTtlMs + 24 * 60 * 60 * 1000),
  });
  await supersedeOlder(email);

  securityLog.record(authorised ? 'OTP_REQUESTED' : 'OTP_REQUEST_UNAUTHORISED', req, { email, authorised, userId: user && user._id });

  const delivered = await deliver(req, challenge, otp, user, 'request');
  if (!delivered.ok) return deliveryFailed();

  return {
    status: 200,
    body: {
      success: true,
      message: GENERIC_SENT,
      challengeId,
      codeLength: cfg.otpLength,
      expiresInSeconds: Math.round(cfg.otpTtlMs / 1000),
      resendAvailableInSeconds: Math.round(cfg.resendCooldownMs / 1000),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
async function resendOtp(req, body) {
  const cfg = config.get();
  if (!cfg.enabled) return fail(503, 'ADMIN_AUTH_NOT_CONFIGURED', 'Admin sign-in is not available right now.');

  const email = parseEmail(body && body.email);
  const challengeId = typeof body?.challengeId === 'string' && CHALLENGE_RE.test(body.challengeId) ? body.challengeId : null;
  if (!email || !challengeId) return fail(400, 'INVALID_REQUEST', 'Start again with your email address.');

  const ip = await ipLimit(req, 'admin-otp-request-ip', cfg.ipMaxOtpRequests);
  if (!ip.allowed) return rateLimited(req, email, false, ip.retryAfterSeconds, 'ip');

  const existing = await AdminLoginChallenge.findOne({ challengeId });
  if (!existing || existing.email !== email) return fail(400, 'CHALLENGE_INVALID', 'This sign-in request is no longer valid. Start again with your email address.');
  if (existing.status !== 'PENDING') return fail(410, 'CHALLENGE_CLOSED', 'This sign-in request has ended. Start again with your email address.');

  const now = new Date();
  // Atomic cooldown claim: two quick clicks cannot both resend.
  const claimed = await AdminLoginChallenge.findOneAndUpdate(
    { _id: existing._id, status: 'PENDING', lastSentAt: { $lte: new Date(now.getTime() - cfg.resendCooldownMs) } },
    { $set: { lastSentAt: now } },
    { new: true },
  );
  if (!claimed) {
    const fresh = await AdminLoginChallenge.findById(existing._id).lean();
    if (!fresh || fresh.status !== 'PENDING') return fail(410, 'CHALLENGE_CLOSED', 'This sign-in request has ended. Start again with your email address.');
    const retryAfterSeconds = Math.max(1, Math.ceil((fresh.lastSentAt.getTime() + cfg.resendCooldownMs - now.getTime()) / 1000));
    return fail(429, 'OTP_RESEND_COOLDOWN', `Please wait ${retryAfterSeconds} seconds before requesting another code.`, { retryAfterSeconds });
  }

  // The account may have lost access since the first request.
  const user = claimed.userId ? await identity.findEligibleAdmin(email) : null;
  const authorised = !!user && String(user._id) === String(claimed.userId);

  const id = await rateLimit.hit('admin-otp-send-identity', email, { max: cfg.identityMaxSends, windowMs: cfg.identityWindowMs });
  if (!id.allowed) return rateLimited(req, email, authorised, id.retryAfterSeconds, 'identity');

  const version = (claimed.sendCount || 1) + 1;
  const otp = authorised ? generateOtp(cfg.otpLength) : null;
  // Replacing the hash invalidates the previous code; attempts are NOT reset by a resend.
  const updated = await AdminLoginChallenge.findOneAndUpdate(
    { _id: claimed._id, status: 'PENDING' },
    { $set: {
      otpHash: hashOtp(claimed.challengeId, version, otp || randomToken(16)),
      otpIssuedAt: now,
      sendCount: version,
      expiresAt: new Date(now.getTime() + cfg.otpTtlMs),
      purgeAt: new Date(now.getTime() + cfg.otpTtlMs + 24 * 60 * 60 * 1000),
    } },
    { new: true },
  );
  if (!updated) return fail(410, 'CHALLENGE_CLOSED', 'This sign-in request has ended. Start again with your email address.');

  const delivered = await deliver(req, updated, otp, authorised ? user : null, 'resend');
  if (!delivered.ok) return deliveryFailed();

  return {
    status: 200,
    body: {
      success: true,
      message: GENERIC_SENT,
      challengeId: updated.challengeId,
      codeLength: cfg.otpLength,
      expiresInSeconds: Math.round(cfg.otpTtlMs / 1000),
      resendAvailableInSeconds: Math.round(cfg.resendCooldownMs / 1000),
      attemptsRemaining: Math.max(0, cfg.otpMaxAttempts - updated.attempts),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
async function explainClosed(req, challengeId, email) {
  const cfg = config.get();
  const c = await AdminLoginChallenge.findOne({ challengeId }).lean();
  if (!c || c.email !== email || c.status === 'DELIVERY_FAILED') {
    return fail(400, 'CHALLENGE_INVALID', 'This sign-in request is no longer valid. Start again with your email address.');
  }
  const authorised = !!c.userId;
  if (c.status === 'VERIFIED') {
    securityLog.record('OTP_REUSED', req, { email, authorised, userId: c.userId });
    return fail(410, 'OTP_USED', 'This code has already been used. Request a new code.');
  }
  if (c.status === 'SUPERSEDED') {
    return fail(410, 'OTP_SUPERSEDED', 'A newer code was requested. Use the latest code, or request a new one.');
  }
  if (c.status === 'LOCKED' || c.attempts >= cfg.otpMaxAttempts) {
    return fail(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Request a new code.');
  }
  // PENDING but past expiry (or already marked EXPIRED)
  if (c.status === 'PENDING') {
    await AdminLoginChallenge.updateOne({ _id: c._id, status: 'PENDING' }, { $set: { status: 'EXPIRED', closedAt: new Date() } });
  }
  securityLog.record('OTP_EXPIRED', req, { email, authorised, userId: c.userId });
  return fail(410, 'OTP_EXPIRED', 'This code has expired. Request a new code.');
}

/**
 * @returns {Promise<{status, body, session?: {raw}}>}
 */
async function verifyOtp(req, body) {
  const cfg = config.get();
  if (!cfg.enabled) return fail(503, 'ADMIN_AUTH_NOT_CONFIGURED', 'Admin sign-in is not available right now.');

  const email = parseEmail(body && body.email);
  const challengeId = typeof body?.challengeId === 'string' && CHALLENGE_RE.test(body.challengeId) ? body.challengeId : null;
  const otp = typeof body?.otp === 'string' ? body.otp.trim() : '';
  if (!email || !challengeId) return fail(400, 'INVALID_REQUEST', 'Start again with your email address.');
  if (!OTP_RE.test(otp)) return fail(400, 'INVALID_OTP_FORMAT', 'Enter the 6-digit code.');

  const ip = await ipLimit(req, 'admin-otp-verify-ip', cfg.ipMaxVerifies);
  if (!ip.allowed) return rateLimited(req, email, false, ip.retryAfterSeconds, 'ip-verify');

  const now = new Date();
  // Atomically consume one attempt. Concurrent guesses each take their own attempt, so the
  // limit holds under parallel requests.
  const c = await AdminLoginChallenge.findOneAndUpdate(
    { challengeId, status: 'PENDING', expiresAt: { $gt: now }, attempts: { $lt: cfg.otpMaxAttempts } },
    { $inc: { attempts: 1 } },
    { new: true },
  );
  if (!c) return explainClosed(req, challengeId, email);

  const authorised = !!c.userId;
  const candidate = hashOtp(c.challengeId, c.sendCount || 1, otp);
  const match = authorised && c.email === email && safeEqualHex(candidate, c.otpHash);

  if (!match) {
    const remaining = Math.max(0, cfg.otpMaxAttempts - c.attempts);
    if (remaining === 0) {
      await AdminLoginChallenge.updateOne({ _id: c._id, status: 'PENDING' }, { $set: { status: 'LOCKED', closedAt: new Date() } });
      securityLog.record('OTP_TOO_MANY_ATTEMPTS', req, { email, authorised, userId: c.userId });
      return fail(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Request a new code.', { attemptsRemaining: 0 });
    }
    securityLog.record('OTP_INVALID', req, { email, authorised, userId: c.userId, details: { attemptsRemaining: remaining } });
    return fail(401, 'OTP_INVALID', `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`, { attemptsRemaining: remaining });
  }

  // Single use: only one request can flip PENDING → VERIFIED for this exact code.
  const won = await AdminLoginChallenge.findOneAndUpdate(
    { _id: c._id, status: 'PENDING', otpHash: c.otpHash },
    { $set: { status: 'VERIFIED', closedAt: new Date() } },
    { new: true },
  );
  if (!won) {
    securityLog.record('OTP_REUSED', req, { email, authorised, userId: c.userId });
    return fail(410, 'OTP_USED', 'This code has already been used. Request a new code.');
  }

  // Identity must still be authorised at the moment of sign-in.
  const user = await identity.findEligibleAdmin(email);
  if (!user || String(user._id) !== String(c.userId)) {
    securityLog.record('LOGIN_DENIED', req, { email, authorised: false, userId: c.userId, details: { reason: 'not_authorised_at_verify' } });
    return fail(403, 'ADMIN_ACCESS_DENIED', 'This account does not have admin access.');
  }

  const sessIp = await ipLimit(req, 'admin-session-create-ip', cfg.ipMaxSessions);
  if (!sessIp.allowed) return rateLimited(req, email, true, sessIp.retryAfterSeconds, 'session-ip');

  const created = await sessions.create(user, req);
  securityLog.record('LOGIN_SUCCEEDED', req, { email: user.email, authorised: true, userId: user._id, details: { role: user.role } });

  return {
    status: 200,
    session: { raw: created.raw, previous: null },
    body: {
      success: true,
      message: 'Signed in.',
      admin: identity.safeAdminProfile(user),
      csrfToken: created.csrfToken,
      session: sessions.describe(created.session),
    },
  };
}

module.exports = { requestOtp, resendOtp, verifyOtp, GENERIC_SENT };
