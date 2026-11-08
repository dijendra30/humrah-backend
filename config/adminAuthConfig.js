// config/adminAuthConfig.js — Admin Dashboard sign-in (email OTP) settings.
//
// Everything comes from server environment variables; nothing here is ever sent to a client.
//   ADMIN_OTP_DESTINATION   the ONLY mailbox that receives admin sign-in codes (e.g. the support inbox)
//   ADMIN_ALLOWED_EMAILS    comma-separated admin identities allowed to ask for a code
//   ADMIN_AUTH_SECRET       HMAC key for codes, CSRF tokens and IP hashes (≥32 chars). When unset,
//                           a key is derived from OTP_PEPPER (already required at startup).
// The rest are optional tuning knobs with safe defaults (see DEFAULTS below).
'use strict';

const crypto = require('crypto');

const EMAIL_RE = /^[a-z0-9._%+\-']{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const normEmail = v => String(v || '').trim().toLowerCase();
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const int = (v, d, min, max) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};
const flag = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  return /^(1|true|on|yes)$/i.test(String(v).trim());
};

function deriveSecret(env) {
  if (env.ADMIN_AUTH_SECRET && String(env.ADMIN_AUTH_SECRET).length >= 32) return { secret: String(env.ADMIN_AUTH_SECRET), source: 'ADMIN_AUTH_SECRET' };
  if (env.OTP_PEPPER && String(env.OTP_PEPPER).length >= 16) {
    const k = crypto.createHmac('sha256', String(env.OTP_PEPPER)).update('humrah-admin-auth/v1').digest('hex');
    return { secret: k, source: 'OTP_PEPPER(derived)' };
  }
  return { secret: '', source: null };
}

function load(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const otpDestination = normEmail(env.ADMIN_OTP_DESTINATION);
  const allowedEmails = new Set(list(env.ADMIN_ALLOWED_EMAILS).map(normEmail).filter(e => EMAIL_RE.test(e)));
  const { secret, source } = deriveSecret(env);

  const problems = [];
  if (!EMAIL_RE.test(otpDestination)) problems.push('ADMIN_OTP_DESTINATION');
  if (allowedEmails.size === 0) problems.push('ADMIN_ALLOWED_EMAILS');
  if (!secret) problems.push('ADMIN_AUTH_SECRET');

  const cookieSecure = flag(env.ADMIN_COOKIE_SECURE, true);
  const dashboardOrigins = list(env.ADMIN_DASHBOARD_ORIGINS || 'https://admin.humrah.in')
    .map(o => o.replace(/\/+$/, '').toLowerCase());

  return Object.freeze({
    production,
    enabled: problems.length === 0,
    problems: Object.freeze(problems),
    otpDestination,
    allowedEmails,
    secret,
    secretSource: source,

    otpLength: 6,
    otpTtlMs: int(env.ADMIN_OTP_TTL_MINUTES, 5, 1, 30) * 60 * 1000,
    otpMaxAttempts: int(env.ADMIN_OTP_MAX_ATTEMPTS, 5, 1, 10),
    resendCooldownMs: int(env.ADMIN_OTP_RESEND_COOLDOWN_SECONDS, 60, 10, 900) * 1000,
    identityWindowMs: int(env.ADMIN_OTP_WINDOW_MINUTES, 15, 1, 1440) * 60 * 1000,
    identityMaxSends: int(env.ADMIN_OTP_MAX_PER_WINDOW, 3, 1, 50),
    ipWindowMs: int(env.ADMIN_AUTH_IP_WINDOW_MINUTES, 15, 1, 1440) * 60 * 1000,
    ipMaxOtpRequests: int(env.ADMIN_AUTH_IP_MAX_OTP_REQUESTS, 10, 1, 1000),
    ipMaxVerifies: int(env.ADMIN_AUTH_IP_MAX_VERIFY_ATTEMPTS, 30, 1, 1000),
    ipMaxSessions: int(env.ADMIN_AUTH_IP_MAX_SESSIONS, 10, 1, 1000),

    sessionTtlMs: int(env.ADMIN_SESSION_TTL_HOURS, 8, 1, 72) * 60 * 60 * 1000,
    sessionIdleMs: int(env.ADMIN_SESSION_IDLE_MINUTES, 30, 5, 1440) * 60 * 1000,
    socketTokenTtlSeconds: 120,

    cookieSecure,
    // __Host- cookies must be Secure, Path=/ and carry no Domain: bound to api.humrah.in only.
    cookieName: cookieSecure ? '__Host-humrah_admin_sid' : 'humrah_admin_sid',
    requireHttps: flag(env.ADMIN_REQUIRE_HTTPS, production),
    dashboardOrigins: Object.freeze(dashboardOrigins),

    // Transition switches (see ADMIN_OTP_DEPLOYMENT_CHECKLIST.md)
    legacyDashboardTokens: flag(env.ADMIN_LEGACY_DASHBOARD_TOKENS, false), // old 24 h localStorage JWTs
    appAdminTokens: flag(env.ADMIN_APP_TOKEN_ACCESS, true),                // Android admin screens (phone sign-in)

    emailProvider: String(env.ADMIN_OTP_EMAIL_PROVIDER || (env.RESEND_API_KEY ? 'resend' : (env.BREVO_API_KEY ? 'brevo' : 'none'))).trim().toLowerCase(),
    emailFrom: env.ADMIN_OTP_FROM || 'Humrah Admin <safety@system.humrah.in>',
    emailTimeoutMs: 10000,
  });
}

let cached = null;
const get = () => (cached || (cached = load()));
/** Re-reads process.env (startup and tests). */
const reload = () => (cached = load());

module.exports = { get, reload, load, normEmail, EMAIL_RE };
