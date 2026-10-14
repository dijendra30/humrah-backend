// services/quickConnect/config.js
// -----------------------------------------------------------------------------
// Quick Connect configuration. Everything comes from process.env (Coolify in
// production) and is read on EVERY call, so changing a value needs only a
// restart/redeploy — never a database change. Every value fails closed:
//
//   QUICK_CONNECT_ENABLED           exactly "true" (any case, trimmed) enables;
//                                   missing / empty / anything else = OFF
//   QUICK_CONNECT_CONSENT_VERSION   the consent version users must have accepted;
//                                   missing or malformed = nobody satisfies consent
//   QUICK_CONNECT_BETA_USER_IDS     comma-separated user ids an operator has
//                                   personally checked (age assurance for the
//                                   closed beta); empty = nobody passes
//   TURN_SHARED_SECRET              coturn static-auth-secret; validated on use,
//                                   never logged, never returned
//   QUICK_CONNECT_TURN_URIS         optional comma-separated turn: URIs
//   QUICK_CONNECT_TURN_TTL_SECONDS  optional credential lifetime, 60..600 (default 600)
//   QUICK_CONNECT_MATCH_FALLBACK_MS optional, shared-interest wait before broadening (default 20000)
//   QUICK_CONNECT_SEARCH_TIMEOUT_MS optional, open search lifetime (default 120000)
//   QUICK_CONNECT_SWEEP_INTERVAL_MS optional, lifecycle sweeper period (default 10000)
//
// None of these is in server.js's REQUIRED_ENV_VARS on purpose: a missing value
// must switch Quick Connect off, not stop the whole app from starting.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const DEFAULT_TURN_URIS = Object.freeze([
  'turn:turn.humrah.in:3478?transport=udp',
  'turn:turn.humrah.in:3478?transport=tcp'
]);
const TURN_URI_PATTERN = /^turns?:[A-Za-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/;
const DEFAULT_TTL_SECONDS = 600;   // = coturn max-allocate-lifetime on turn.humrah.in
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 600;
const MIN_SECRET_LENGTH = 32;
const MAX_BETA_USERS = 500;

const raw = name => (typeof process.env[name] === 'string' ? process.env[name] : '');

function isEnabled() {
  return raw('QUICK_CONNECT_ENABLED').trim().toLowerCase() === 'true';
}

/** The required consent version, or null when unset/malformed (then consent can never be satisfied). */
function requiredConsentVersion() {
  const v = raw('QUICK_CONNECT_CONSENT_VERSION').trim();
  return CONSENT_VERSION_PATTERN.test(v) ? v : null;
}

/** Set of valid ObjectId strings; malformed entries are ignored (never widen access). */
function betaUserIds() {
  const ids = new Set();
  for (const part of raw('QUICK_CONNECT_BETA_USER_IDS').split(',')) {
    const id = part.trim().toLowerCase();
    if (/^[0-9a-f]{24}$/.test(id) && mongoose.isValidObjectId(id)) ids.add(id);
    if (ids.size >= MAX_BETA_USERS) break;
  }
  return ids;
}

/**
 * The TURN secret, or null when it is missing or unusable. Never trimmed or
 * repaired: coturn compares the exact bytes, so a secret with stray whitespace
 * would mint credentials coturn rejects — refuse it instead.
 */
function turnSecret() {
  const s = raw('TURN_SHARED_SECRET');
  if (s.length < MIN_SECRET_LENGTH || s.length > 512) return null;
  if (!/^[\x21-\x7e]+$/.test(s)) return null;   // printable ASCII, no whitespace
  return s;
}

function turnUris() {
  const configured = raw('QUICK_CONNECT_TURN_URIS').split(',').map(u => u.trim()).filter(Boolean);
  if (configured.length === 0) return [...DEFAULT_TURN_URIS];
  return configured.every(u => TURN_URI_PATTERN.test(u)) ? configured : null;
}

function turnTtlSeconds() {
  const v = raw('QUICK_CONNECT_TURN_TTL_SECONDS').trim();
  if (!v) return DEFAULT_TTL_SECONDS;
  if (!/^\d+$/.test(v)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Number(v)));
}

/** Bounded integer from env, or the default when missing/malformed. */
function boundedMs(name, def, min, max) {
  const v = raw(name).trim();
  if (!/^\d+$/.test(v)) return def;
  return Math.min(max, Math.max(min, Number(v)));
}

/** Phase 5: how long a search waits for a shared-interest match before broadening (5–120 s). */
const matchFallbackMs = () => boundedMs('QUICK_CONNECT_MATCH_FALLBACK_MS', 20000, 5000, 120000);
/** Phase 5: how long a search may stay open before it is cancelled (60–600 s). */
const searchTimeoutMs = () => boundedMs('QUICK_CONNECT_SEARCH_TIMEOUT_MS', 120000, 60000, 600000);
/** Phase 5: lifecycle sweeper period (5–60 s). Time limits are enforced within one period. */
const sweepIntervalMs = () => boundedMs('QUICK_CONNECT_SWEEP_INTERVAL_MS', 10000, 5000, 60000);

/** TURN settings, or null when any part is unusable (credential minting then refuses). */
function turnConfig() {
  const secret = turnSecret();
  const uris = turnUris();
  if (!secret || !uris) return null;
  return { secret, uris, ttlSeconds: turnTtlSeconds() };
}

module.exports = {
  isEnabled,
  requiredConsentVersion,
  betaUserIds,
  turnConfig,
  turnTtlSeconds,
  matchFallbackMs,
  searchTimeoutMs,
  sweepIntervalMs,
  CONSENT_VERSION_PATTERN,
  DEFAULT_TURN_URIS,
  MIN_SECRET_LENGTH,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS
};
