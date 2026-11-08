// middleware/adminSessionGate.js — the backend gate in front of EVERY admin API.
//
// Mounted in server.js on all admin path prefixes (ADMIN_ONLY_PREFIXES) before the existing
// routers, so a route that forgot its own role check is still protected. It accepts:
//   • the Admin Dashboard session cookie (HttpOnly, server-side session, CSRF on writes), or
//   • a phone (Android app) Bearer token of an admin account — the in-app admin screens —
//     unless ADMIN_APP_TOKEN_ACCESS=off.
// It refuses:
//   • no credentials                                  → 401
//   • expired / idle / revoked dashboard session      → 401
//   • dashboard access removed (allowlist/role/status) → 401 (session is revoked)
//   • old 24 h dashboard JWTs (unless ADMIN_LEGACY_DASHBOARD_TOKENS=on) → 401
//   • a non-admin account (normal user token)         → 403
//   • a cookie write without a valid CSRF token / from a foreign Origin → 403
// The existing per-route `authenticate` + role middleware still run afterwards; `authenticate`
// sees req.adminAuthResolved and does not repeat the lookup.
'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/adminAuthConfig');
const sessions = require('../services/adminAuth/adminSessionService');
const identity = require('../services/adminAuth/adminIdentity');
const securityLog = require('../services/adminAuth/adminSecurityLog');
const { safeEqualHex } = require('../services/adminAuth/adminAuthCrypto');
const { sectionForPath, OWNER } = require('../services/adminAuth/adminPermissions');

const DASHBOARD_SCOPE = 'admin-dashboard';
const ADMIN_SOCKET_SCOPE = 'admin-socket';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every path prefix that serves admin-only operations (keep in sync with ADMIN_ROUTE_AUDIT.md). */
const ADMIN_ONLY_PREFIXES = Object.freeze([
  '/api/admin',                    // routes/admin.js, branding, broadcasts, launch-regions, places, moderation, questions, app-updates, sports-discovery
  '/api/admin-dashboard',          // routes/adminDashboard.js
  '/api/admin-analytics',          // routes/adminAnalytics.js
  '/api/moderation',               // routes/moderation.js
  '/api/home-banners/admin',       // routes/homeBanners.js (admin half)
  '/api/official-events/admin',    // routes/officialEvents.js (admin half)
  '/api/event-requests/admin',     // routes/eventRequests.js (admin half)
  '/api/founder/admin',            // routes/founder.js (admin half)
  '/api/safety/admin',             // routes/safetyReports.js (admin half, Android admin screens)
  '/api/users/admin',              // routes/users.js /admin/pending-verifications
  '/api/verification/admin',       // routes/verification.js (admin half)
  '/api/reviews/admin',            // routes/reviews.js (admin half)
  '/api/payment/admin',            // routes/payment.js trigger-payout
  '/api/auth/create-admin',        // routes/auth.js
]);

/** User routes the dashboard also calls as the signed-in admin (cookie allowed, no admin-only backstop). */
const SHARED_DASHBOARD_PREFIXES = Object.freeze([
  '/api/founder/chats',            // dashboard founder chat (GET list, GET/POST messages)
]);

const deny = (res, status, code, message) => res.status(status).json({ success: false, code, message });

function bearerOf(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true; // non-browser clients; the cookie is SameSite=Strict + CSRF-bound anyway
  return config.get().dashboardOrigins.includes(origin.replace(/\/+$/, '').toLowerCase());
}

/** Resolves the dashboard cookie session. Sends the error response itself and returns null on failure. */
async function resolveCookieSession(req, res, raw) {
  const r = await sessions.resolve(raw);
  if (!r.ok) {
    sessions.clearCookie(res);
    if (r.session && (r.reason === 'EXPIRED' || r.reason === 'IDLE')) {
      await sessions.revoke(r.session, r.reason === 'IDLE' ? 'IDLE_TIMEOUT' : 'EXPIRED');
      securityLog.record('SESSION_EXPIRED', req, { email: r.session.email, authorised: true, userId: r.session.userId, details: { reason: r.reason } });
    }
    deny(res, 401, 'ADMIN_SESSION_EXPIRED', 'Your admin session has ended. Please sign in again.');
    return null;
  }
  const { session } = r;
  const User = require('../models/User');
  const user = await User.findById(session.userId).select('-password');
  const access = await identity.sessionAccess(user, session);
  if (!access) {
    await sessions.revoke(session, 'ACCESS_REVOKED');
    sessions.clearCookie(res);
    securityLog.record('ADMIN_ACCESS_REVOKED', req, { email: session.email, authorised: true, userId: session.userId });
    deny(res, 401, 'ADMIN_ACCESS_REVOKED', 'Admin access for this account has been removed.');
    return null;
  }
  if (!SAFE_METHODS.has(req.method)) {
    const sent = req.get('x-csrf-token') || '';
    if (!originAllowed(req) || !safeEqualHex(sent, sessions.csrfTokenOf(session))) {
      securityLog.record('CSRF_REJECTED', req, { email: session.email, authorised: true, userId: session.userId, details: { reason: originAllowed(req) ? 'token' : 'origin' } });
      deny(res, 403, 'CSRF_FAILED', 'This request could not be verified. Reload the page and try again.');
      return null;
    }
  }
  await sessions.touch(session);
  return { session, user, access };
}

/** null when this admin may use the API path, otherwise the section key that is missing. */
function missingSection(req, access) {
  const section = sectionForPath(req.originalUrl || req.url);
  if (section === OWNER) return access.isOwner ? null : OWNER;
  return access.sections.includes(section) ? null : section;
}

function denySection(req, res, access, section) {
  securityLog.record('SECTION_FORBIDDEN', req, { email: req.user?.email, authorised: true, userId: req.user?._id, details: { section, role: access.kind } });
  return res.status(403).json({
    success: false,
    code: section === OWNER ? 'ADMIN_OWNER_ONLY' : 'ADMIN_SECTION_FORBIDDEN',
    section,
    message: section === OWNER
      ? 'Only the account owner can use this area.'
      : "You don't have permission to access this section.",
  });
}

function attach(req, user, session, access) {
  req.adminAccess = access;
  req.user = user;
  req.userId = user._id;
  req.adminSession = session;
  req.auth = { sid: null, scope: 'admin-session', tv: session.tv ?? 0, iat: Math.floor(session.createdAt.getTime() / 1000) };
  req.adminAuthResolved = true;
}

/**
 * @param {{ adminOnly?: boolean, cookieOnly?: boolean, checkSections?: boolean }} opts
 *   adminOnly  — refuse non-admin accounts with 403 (all admin prefixes)
 *   cookieOnly — only the dashboard session is accepted (the /api/admin/auth session endpoints)
 *   checkSections — enforce the section/owner map (services/adminAuth/adminPermissions.js)
 */
function adminSessionGate({ adminOnly = true, cookieOnly = false, checkSections = true } = {}) {
  return async function adminGate(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    try {
      const cfg = config.get();
      const bearer = cookieOnly ? null : bearerOf(req);

      // Shared user routes: phone/app requests pass through untouched (the normal authenticate runs).
      if (bearer && !adminOnly) return next();

      if (bearer) {
        const decoded = jwt.decode(bearer) || {};
        if (decoded.scope === ADMIN_SOCKET_SCOPE) return deny(res, 401, 'INVALID_TOKEN', 'Invalid token');
        if (decoded.scope === DASHBOARD_SCOPE && !cfg.legacyDashboardTokens) {
          securityLog.record('LEGACY_TOKEN_REJECTED', req, { userId: decoded.userId });
          return deny(res, 401, 'ADMIN_REAUTH_REQUIRED', 'Admin sign-in has changed. Please sign in again.');
        }
        if (decoded.scope !== DASHBOARD_SCOPE && adminOnly && !cfg.appAdminTokens) {
          securityLog.record('APP_TOKEN_REJECTED', req, { userId: decoded.userId });
          return deny(res, 403, 'ADMIN_DASHBOARD_REQUIRED', 'Admin operations are only available in the admin dashboard.');
        }
        // Full verification (signature, expiry, tokenVersion, phone session, account status).
        const { authenticate } = require('./auth');
        return authenticate(req, res, async () => {
          try {
            if (adminOnly && !identity.isAdminRole(req.user?.role)) {
              securityLog.record('FORBIDDEN_ADMIN_API_ACCESS', req, { userId: req.user?._id, details: { role: String(req.user?.role || '') } });
              return deny(res, 403, 'ADMIN_FORBIDDEN', 'You do not have permission to access this resource.');
            }
            // Dashboard members signing in on the phone get exactly their dashboard sections.
            const phone = await identity.phoneAccess(req.user);
            if (phone.managed) {
              if (!phone.access) {
                securityLog.record('FORBIDDEN_ADMIN_API_ACCESS', req, { userId: req.user._id, details: { reason: 'member_removed' } });
                return deny(res, 403, 'ADMIN_FORBIDDEN', 'You do not have permission to access this resource.');
              }
              const missing = checkSections ? missingSection(req, phone.access) : null;
              if (missing) return denySection(req, res, phone.access, missing);
              req.adminAccess = phone.access;
            }
            req.adminAuthResolved = true;
            return next();
          } catch (err) {
            console.error('[admin-gate] phone access error:', err && err.name);
            if (!res.headersSent) deny(res, 500, 'SERVER_ERROR', 'Authentication failed.');
            return undefined;
          }
        });
      }

      const raw = sessions.readCookie(req);
      if (!raw) {
        if (!adminOnly) return next(); // shared user route: the normal authenticate decides
        return deny(res, 401, 'ADMIN_AUTH_REQUIRED', 'Authentication required.');
      }

      const resolved = await resolveCookieSession(req, res, raw);
      if (!resolved) return undefined;
      attach(req, resolved.user, resolved.session, resolved.access);
      const missing = checkSections ? missingSection(req, resolved.access) : null;
      if (missing) return denySection(req, res, resolved.access, missing);
      return next();
    } catch (err) {
      console.error('[admin-gate] error:', err && err.name, err && err.message);
      if (!res.headersSent) return deny(res, 500, 'SERVER_ERROR', 'Authentication failed.');
      return undefined;
    }
  };
}

/** Owner guard (ADMIN_ALLOWED_EMAILS + SUPER_ADMIN) for a resolved dashboard session. */
const requireOwner = (req, res, next) => {
  if (req.adminAccess && req.adminAccess.isOwner) return next();
  return denySection(req, res, req.adminAccess || { kind: 'unknown' }, OWNER);
};

/** Role guard for a resolved admin session (e.g. SUPER_ADMIN-only endpoints in the auth router). */
const requireRole = (...roles) => (req, res, next) => {
  if (roles.map(r => r.toUpperCase()).includes(String(req.user?.role || '').toUpperCase())) return next();
  securityLog.record('FORBIDDEN_ADMIN_API_ACCESS', req, { userId: req.user?._id, details: { role: String(req.user?.role || ''), requiredRole: roles.join('|') } });
  return deny(res, 403, 'ADMIN_FORBIDDEN', 'You do not have permission to access this resource.');
};

module.exports = { adminSessionGate, requireRole, requireOwner, missingSection, ADMIN_ONLY_PREFIXES, SHARED_DASHBOARD_PREFIXES, DASHBOARD_SCOPE, ADMIN_SOCKET_SCOPE, originAllowed };
