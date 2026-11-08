// services/adminAuth/adminSecurityLog.js — write-only, best-effort security events.
// A logging failure never blocks or changes an authentication decision.
'use strict';

const AdminSecurityEvent = require('../../models/AdminSecurityEvent');
const { requestMeta, maskEmail, hmac } = require('./adminAuthCrypto');

const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// Only these keys survive into `details`; values are clipped. Nothing sensitive is ever passed in,
// this is a second line of defence.
const SAFE_DETAIL_KEYS = new Set(['reason', 'code', 'attemptsRemaining', 'retryAfterSeconds', 'provider', 'role', 'requiredRole', 'scope', 'sendCount', 'challenge']);

function cleanDetails(details) {
  if (!details || typeof details !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(k)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 120) : (typeof v === 'number' || typeof v === 'boolean' ? v : undefined);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {string} type  AdminSecurityEvent.TYPES
 * @param {object} req   express request (for IP/UA/path)
 * @param {{ email?: string, authorised?: boolean, userId?: any, details?: object }} info
 */
function record(type, req, info = {}) {
  try {
    const meta = req ? requestMeta(req) : {};
    const email = info.email ? String(info.email).toLowerCase() : null;
    const doc = {
      type,
      at: new Date(),
      email: email && info.authorised ? email : null,
      emailMasked: email ? maskEmail(email) : null,
      emailHash: email ? hmac('admin-email', email) : null,
      userId: info.userId || null,
      ipPrefix: meta.ipPrefix || null,
      ipHash: meta.ipHash || null,
      userAgent: meta.userAgent || null,
      method: req ? req.method : null,
      path: req ? String(req.originalUrl || req.url || '').split('?')[0].slice(0, 200) : null,
      details: cleanDetails(info.details),
      expireAt: new Date(Date.now() + RETENTION_MS),
    };
    return AdminSecurityEvent.create(doc).catch(err => {
      console.error('[admin-security-log] write failed:', err && err.name);
    });
  } catch (err) {
    console.error('[admin-security-log] build failed:', err && err.name);
    return Promise.resolve();
  }
}

module.exports = { record };
