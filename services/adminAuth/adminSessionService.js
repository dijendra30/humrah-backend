// services/adminAuth/adminSessionService.js — server-side Admin Dashboard sessions.
'use strict';

const config = require('../../config/adminAuthConfig');
const AdminSession = require('../../models/AdminSession');
const { randomToken, sha256, csrfFor, requestMeta } = require('./adminAuthCrypto');

const TOUCH_EVERY_MS = 60 * 1000;

/** Creates a fresh session (new random id every sign-in: no fixation). Returns the raw cookie value once. */
async function create(user, req) {
  const cfg = config.get();
  const now = Date.now();
  const raw = randomToken(32);
  const idHash = sha256(raw);
  const meta = requestMeta(req);
  const session = await AdminSession.create({
    idHash,
    userId: user._id,
    email: config.normEmail(user.email),
    role: user.role,
    tv: user.tokenVersion ?? 0,
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + cfg.sessionTtlMs),
    idleMs: cfg.sessionIdleMs,
    ipPrefix: meta.ipPrefix,
    userAgent: meta.userAgent,
    purgeAt: new Date(now + cfg.sessionTtlMs + 7 * 24 * 60 * 60 * 1000),
  });
  return { raw, session, csrfToken: csrfFor(idHash) };
}

/**
 * @returns {Promise<{ ok:true, session } | { ok:false, reason:'MISSING'|'REVOKED'|'EXPIRED'|'IDLE', session? }>}
 */
async function resolve(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return { ok: false, reason: 'MISSING' };
  const session = await AdminSession.findOne({ idHash: sha256(raw) });
  if (!session) return { ok: false, reason: 'MISSING' };
  if (session.revokedAt) return { ok: false, reason: 'REVOKED', session };
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) return { ok: false, reason: 'EXPIRED', session };
  if (session.lastSeenAt.getTime() + session.idleMs <= now) return { ok: false, reason: 'IDLE', session };
  return { ok: true, session };
}

async function touch(session) {
  const now = Date.now();
  if (now - session.lastSeenAt.getTime() < TOUCH_EVERY_MS) return;
  await AdminSession.updateOne({ _id: session._id, revokedAt: null }, { $set: { lastSeenAt: new Date(now) } });
}

async function revoke(session, reason) {
  if (!session) return;
  await AdminSession.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: String(reason || 'REVOKED').slice(0, 40) } });
}

/** True when the session behind a socket token is still live (used by socket handshakes). */
async function isLiveById(sessionId) {
  if (!sessionId) return false;
  const s = await AdminSession.findById(sessionId).lean().catch(() => null);
  if (!s || s.revokedAt) return false;
  const now = Date.now();
  return s.expiresAt.getTime() > now && s.lastSeenAt.getTime() + s.idleMs > now;
}

const csrfTokenOf = session => csrfFor(session.idHash);

function describe(session) {
  return {
    expiresAt: session.expiresAt.toISOString(),
    idleTimeoutSeconds: Math.round(session.idleMs / 1000),
  };
}

// ── cookies ──────────────────────────────────────────────────────────────────
function cookieOptions(maxAgeMs) {
  const cfg = config.get();
  return { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict', path: '/', maxAge: maxAgeMs };
}
function setCookie(res, raw) {
  res.cookie(config.get().cookieName, raw, cookieOptions(config.get().sessionTtlMs));
}
function clearCookie(res) {
  const { maxAge, ...opts } = cookieOptions(0); // eslint-disable-line no-unused-vars
  res.clearCookie(config.get().cookieName, opts);
}
/** Reads one cookie without adding a dependency (no cookie-parser in this app). */
function readCookie(req) {
  const name = config.get().cookieName;
  const header = req.headers?.cookie;
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

module.exports = { create, resolve, touch, revoke, isLiveById, csrfTokenOf, describe, setCookie, clearCookie, readCookie };
