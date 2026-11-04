// utils/verificationMedia.js
// -----------------------------------------------------------------------------
// Admin playback of verification videos without public URLs.
//
//   - GET /api/admin-dashboard/verifications/pending (admin only) gives each video a link
//     /api/verification-media/<token>. The token is an HMAC-signed { session, admin, expiry }
//     that expires after MEDIA_TOKEN_TTL_SECONDS. Nothing else issues tokens.
//   - The media route checks the token and streams the video from Cloudinary using a signed
//     delivery URL that never leaves the server. It forwards Range requests so the dashboard
//     <video> player can seek. A video already deleted after a decision answers 404.
//   - The route is public (the dashboard's <video src> cannot send the admin's Bearer token),
//     so the token itself is the authorisation: it cannot be forged without the server secret,
//     is bound to one session, and expires.
//   - Tokens, signed URLs and public IDs are never logged.
//
// Older sessions whose video was stored publicly (type 'upload') are streamed the same way, so
// the dashboard no longer hands out their public URLs either.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const MEDIA_TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN_VERSION = 'v1';
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const TOKEN_SHAPE = /^v1\.[A-Za-z0-9_-]{10,600}\.[A-Za-z0-9_-]{43}$/;
const SAFE_RANGE = /^bytes=\d{0,15}-\d{0,15}$/;
const FORWARDED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/** Signing key: VERIFICATION_MEDIA_SECRET, else a key derived from JWT_SECRET (no new env var required). */
function mediaSecret() {
  const own = String(process.env.VERIFICATION_MEDIA_SECRET || '').trim();
  if (own) return own;
  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  if (!jwtSecret) return null;
  return crypto.createHmac('sha256', jwtSecret).update('humrah:verification-media:v1').digest('hex');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** Returns a token for one session's video, or null when no signing key is configured. */
function signMediaToken({ sessionId, adminId }, { now = Date.now(), ttlSeconds = MEDIA_TOKEN_TTL_SECONDS } = {}) {
  const secret = mediaSecret();
  if (!secret || !OBJECT_ID.test(String(sessionId))) return null;
  const claims = { s: String(sessionId), e: Math.floor(now / 1000) + ttlSeconds };
  if (adminId) claims.a = String(adminId);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${TOKEN_VERSION}.${payload}.${hmac(secret, `${TOKEN_VERSION}.${payload}`)}`;
}

/** { ok: true, sessionId, adminId } or { ok: false, reason: 'unconfigured' | 'malformed' | 'signature' | 'expired' } */
function verifyMediaToken(token, { now = Date.now() } = {}) {
  const secret = mediaSecret();
  if (!secret) return { ok: false, reason: 'unconfigured' };
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { ok: false, reason: 'malformed' };
  const [version, payload, signature] = token.split('.');
  const expected = Buffer.from(hmac(secret, `${version}.${payload}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature' };
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return { ok: false, reason: 'malformed' }; }
  if (!claims || !OBJECT_ID.test(String(claims.s)) || !Number.isFinite(claims.e)) return { ok: false, reason: 'malformed' };
  if (claims.e <= Math.floor(now / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, sessionId: claims.s, adminId: claims.a || null };
}

/** How a session's video is stored, read from its stored reference URL. Legacy sessions are 'upload'. */
function deliveryTypeOf(storedVideoUrl) {
  return typeof storedVideoUrl === 'string' && storedVideoUrl.includes('/video/authenticated/')
    ? 'authenticated' : 'upload';
}

/** Absolute playback link for the dashboard, or null when the video cannot be offered. */
function mediaUrlFor(req, session, adminId) {
  if (!session || !session.cloudinaryPublicId) return null;
  const token = signMediaToken({ sessionId: session._id, adminId });
  if (!token) return null;
  const configured = String(process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const base = configured || `${req.protocol}://${req.get('host')}/api`;
  return `${base}/verification-media/${token}`;
}

function refuse(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

/**
 * Express handler for GET/HEAD /api/verification-media/:token.
 * Dependencies are injectable so tests can use a local stand-in for Cloudinary.
 */
function createVerificationMediaHandler({
  VerificationSession = require('../models/VerificationSession'),
  sourceUrlFor = require('../config/cloudinary').verificationVideoSourceUrl,
  fetchImpl = (...args) => fetch(...args)
} = {}) {
  return async function verificationMediaHandler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The admin dashboard is on another origin; helmet's default (same-origin) would block its <video>.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const check = verifyMediaToken(req.params.token);
    if (!check.ok) {
      if (check.reason === 'unconfigured') return refuse(res, 503, 'MEDIA_UNAVAILABLE', 'Video playback is not available.');
      if (check.reason === 'expired') return refuse(res, 410, 'MEDIA_LINK_EXPIRED', 'This video link has expired. Reload the page to get a new one.');
      return refuse(res, 403, 'MEDIA_FORBIDDEN', 'This video link is not valid.');
    }

    let upstream;
    try {
      const session = await VerificationSession.findById(check.sessionId).select('cloudinaryPublicId videoUrl').lean();
      if (!session || !session.cloudinaryPublicId) {
        return refuse(res, 404, 'MEDIA_NOT_FOUND', 'This verification video is no longer available.');
      }

      const headers = {};
      if (typeof req.headers.range === 'string' && SAFE_RANGE.test(req.headers.range)) headers.Range = req.headers.range;
      const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

      const type = deliveryTypeOf(session.videoUrl);
      upstream = await fetchImpl(sourceUrlFor(session.cloudinaryPublicId, type), { method, headers, redirect: 'follow' });
      // A legacy public video converted to 'authenticated' after its link was stored.
      if (upstream.status === 404 && type === 'upload') {
        upstream = await fetchImpl(sourceUrlFor(session.cloudinaryPublicId, 'authenticated'), { method, headers, redirect: 'follow' });
      }

      if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
        console.error(`[verification-media] storage answered ${upstream.status} (type=${type})`);
        try { if (upstream.body) await upstream.body.cancel(); } catch (_) { /* ignore */ }
        return refuse(res, 502, 'MEDIA_UNAVAILABLE', 'The verification video could not be loaded. Please try again.');
      }

      res.status(upstream.status);
      for (const name of FORWARDED_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      if (!upstream.headers.get('content-type')) res.setHeader('content-type', 'video/mp4');
      if (method === 'HEAD' || !upstream.body || upstream.status === 416) return res.end();

      const body = Readable.fromWeb(upstream.body);
      res.on('close', () => { if (!res.writableEnded) body.destroy(); });
      body.on('error', (err) => {
        console.error(`[verification-media] stream interrupted: ${err.name || 'Error'}`);
        res.destroy();
      });
      body.pipe(res);
    } catch (err) {
      console.error(`[verification-media] failed: ${err.name || 'Error'}`);
      if (!res.headersSent) return refuse(res, 502, 'MEDIA_UNAVAILABLE', 'The verification video could not be loaded. Please try again.');
      res.destroy();
    }
  };
}

module.exports = {
  MEDIA_TOKEN_TTL_SECONDS,
  signMediaToken,
  verifyMediaToken,
  deliveryTypeOf,
  mediaUrlFor,
  createVerificationMediaHandler
};
