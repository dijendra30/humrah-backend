// utils/linkSafety.js
// -----------------------------------------------------------------------------
// Sports chat enhancement — checking a link before the app opens it.
//
// WHAT A VERDICT MEANS. Nothing here ever calls a link "safe" on its own say-so.
//   SAFE     Google Web Risk looked the URL up and it is on none of its threat
//            lists ("No known threat found"). Not a guarantee — a statement of
//            what the lookup returned.
//   UNSAFE   Web Risk lists it (malware, social engineering or unwanted software).
//   UNKNOWN  anything else: no Web Risk key configured, the lookup timed out or
//            failed. The app says "We couldn't verify this link".
//
// WHY WEB RISK. Humrah has no URL-reputation service. Google Safe Browsing v4 is
// licensed for non-commercial use only; Web Risk is Google's commercial product
// for the same lists (Lookup API: GET webrisk.googleapis.com/v1/uris:search; an
// empty {} means "not on any threat list"; 100,000 lookups a month free).
//
// OFF UNTIL CONFIGURED. It is used only when the WEB_RISK_API_KEY environment
// variable is set on the server. Without it every check is UNKNOWN and no URL
// leaves the server.
//
// PRIVACY. Only the URL itself is sent — no user id, no message, no name — and
// only when a member taps a link that appears in a message they can see (the
// route checks that). Results are cached under a SHA-256 of the URL, never the
// URL itself, and nothing here logs a URL.
//
// WHAT COUNTS AS A LINK. http:// and https:// only, with a real host name and no
// user:password@ part (a classic way to disguise where a link goes). Nothing
// else — javascript:, file:, intent:, data:, custom schemes — is ever a link.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const redisService = require('../services/redisService');

const URL_MAX           = 2048;
const LOOKUP_TIMEOUT_MS = 3000;
const SAFE_CACHE_S      = 10 * 60;
const THREAT_CACHE_MAX_S = 30 * 60;
const THREAT_TYPES      = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'];
const ENDPOINT          = 'https://webrisk.googleapis.com/v1/uris:search';

/**
 * A web link as the app may open it, or null. [raw] is the text as it appears in
 * the message. Returns the parsed URL's own host — what the user is shown — so a
 * link's text can never disguise where it goes.
 */
function parseWebUrl(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > URL_MAX) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  let u;
  try { u = new URL(text); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  // A real name: at least one dot, or an IPv6 literal. "http://intranet" is not a link.
  if (!host || (!host.includes('.') && !host.startsWith('['))) return null;
  return { href: u.href, host, secure: u.protocol === 'https:' };
}

// The transport, replaceable in tests. Resolves to the parsed JSON body.
let transport = async (url, signal) => {
  const res = await fetch(url, { method: 'GET', signal });
  if (!res.ok) throw new Error(`web risk HTTP ${res.status}`);
  return res.json();
};

const cacheKey = href => `sports:linkcheck:${crypto.createHash('sha256').update(href).digest('hex')}`;

/**
 * The verdict for one parsed link. Always resolves; never throws.
 * @returns {{ verdict: 'SAFE'|'UNSAFE'|'UNKNOWN', checkedBy: 'WEB_RISK'|null, threatTypes?: string[], reason?: string }}
 */
async function checkLink(parsed) {
  const key = process.env.WEB_RISK_API_KEY;
  if (!key) return { verdict: 'UNKNOWN', checkedBy: null, reason: 'NOT_CONFIGURED' };

  const ck = cacheKey(parsed.href);
  try {
    const v = await redisService.get(ck);
    if (v && (v.verdict === 'SAFE' || v.verdict === 'UNSAFE')) return { ...v, checkedBy: 'WEB_RISK', cached: true };
  } catch (_) { /* a cache miss */ }

  const qs = new URLSearchParams();
  for (const t of THREAT_TYPES) qs.append('threatTypes', t);
  qs.append('uri', parsed.href);
  qs.append('key', key);

  let body;
  try {
    body = await transport(`${ENDPOINT}?${qs.toString()}`, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
  } catch (err) {
    // Never the URL, never the key.
    console.warn('[SPORTS_LINK_CHECK] lookup failed:', err && err.name === 'TimeoutError' ? 'timeout' : (err && err.message ? String(err.message).slice(0, 80) : 'error'));
    return { verdict: 'UNKNOWN', checkedBy: null, reason: 'CHECK_FAILED' };
  }

  let out;
  let ttl = SAFE_CACHE_S;
  if (body && body.threat && Array.isArray(body.threat.threatTypes) && body.threat.threatTypes.length) {
    out = { verdict: 'UNSAFE', threatTypes: body.threat.threatTypes.map(String).slice(0, 5) };
    const expires = Date.parse(body.threat.expireTime || '');
    ttl = Number.isFinite(expires)
      ? Math.max(60, Math.min(THREAT_CACHE_MAX_S, Math.floor((expires - Date.now()) / 1000)))
      : THREAT_CACHE_MAX_S;
  } else if (body && typeof body === 'object' && Object.keys(body).length === 0) {
    out = { verdict: 'SAFE' };
  } else {
    return { verdict: 'UNKNOWN', checkedBy: null, reason: 'UNEXPECTED_RESPONSE' };
  }
  try { await redisService.set(ck, out, ttl); } catch (_) { /* uncached is fine */ }
  return { ...out, checkedBy: 'WEB_RISK' };
}

module.exports = {
  parseWebUrl,
  checkLink,
  _internal: {
    URL_MAX, THREAT_TYPES, ENDPOINT, cacheKey,
    /** Tests only: replace the HTTP call. */
    setTransport: fn => { transport = fn; },
  },
};
