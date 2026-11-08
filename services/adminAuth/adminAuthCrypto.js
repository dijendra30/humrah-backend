// services/adminAuth/adminAuthCrypto.js — primitives for Admin Dashboard sign-in.
'use strict';

const crypto = require('crypto');
const config = require('../../config/adminAuthConfig');

const secret = () => config.get().secret;

/** Six-digit code from the OS CSPRNG (uniform, leading zeros kept). */
function generateOtp(length = 6) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const hmac = (label, v) => crypto.createHmac('sha256', secret()).update(`${label}\u0000${v}`).digest('hex');

/** Keyed hash bound to the challenge and to this particular send (a resend changes `version`). */
const hashOtp = (challengeId, version, otp) => hmac('admin-otp', `${challengeId}:${version}:${otp}`);

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** CSRF token bound to one session (double-submit: header must equal this). */
const csrfFor = sessionIdHash => hmac('admin-csrf', sessionIdHash);

function ipPrefix(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').slice(0, 3).join('.') + '.0/24';
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + '::/48';
  return null;
}

function requestMeta(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return {
    ip,
    ipHash: ip ? hmac('admin-ip', ip) : null,
    ipPrefix: ipPrefix(ip),
    userAgent: String(req.get?.('user-agent') || '').slice(0, 200) || null,
  };
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return null;
  return `${local.slice(0, 1)}***@${domain}`;
}

module.exports = { generateOtp, randomToken, sha256, hmac, hashOtp, safeEqualHex, csrfFor, ipPrefix, requestMeta, maskEmail };
