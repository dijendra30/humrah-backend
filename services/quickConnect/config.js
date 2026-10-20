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
//   QUICK_CONNECT_BETA_USER_IDS     optional beta restriction: comma-separated user ids.
//                                   UNSET or empty = no beta restriction (every user who
//                                   passes ALL other eligibility checks may use Quick
//                                   Connect). Set = only these ids. Set but with no valid
//                                   id (typo) = NOBODY passes (fails closed, never opens).
//                                   The list never grants anything by itself.
//   TURN_SHARED_SECRET              coturn static-auth-secret; validated on use,
//                                   never logged, never returned
//   QUICK_CONNECT_TURN_URIS         optional comma-separated turn: URIs
//   QUICK_CONNECT_TURN_TTL_SECONDS  optional credential lifetime, 60..600 (default 600)
//   QUICK_CONNECT_MATCH_FALLBACK_MS optional, shared-interest wait before broadening (default 20000)
//   QUICK_CONNECT_SEARCH_TIMEOUT_MS optional, open search lifetime (default 120000)
//   QUICK_CONNECT_SWEEP_INTERVAL_MS optional, lifecycle sweeper period (default 10000)
//   QUICK_CONNECT_MAX_ACTIVE_CALLS  optional, most open sessions at once (default 10 = the
//                                   measured TURN baseline; 1..500). Raise only after a load test.
//   QUICK_CONNECT_WAITLIST_TTL_MS   optional, how long a "Notify me" request lasts (default 2 h,
//                                   10 min..24 h)
//   QUICK_CONNECT_SKIP_EXCLUSION_MS optional, how long two people are not matched again after
//                                   one skipped the other (default 1800000 = 30 min, 1 min..24 h;
//                                   cannot be switched off)
//   QUICK_CONNECT_SMART_DISCOVERY_ENABLED  exactly "true" enables Smart Discovery invitations
//                                   (services/quickConnect/discovery.js); anything else = OFF.
//                                   Needs QUICK_CONNECT_ENABLED too. Only opted-in users are invited.
//   QUICK_CONNECT_SMART_DISCOVERY_DELAY_MS optional, how long a search runs without a match
//                                   before invitations go out (default 30000, 10 s..90 s)
//   QUICK_CONNECT_INVITE_TTL_MS     optional, how long an invitation can be accepted
//                                   (default 60000, 20 s..3 min)
//   QUICK_CONNECT_INVITES_PER_SEARCH optional, most invitations one search sends (default 3, 1..10)
//   QUICK_CONNECT_INVITE_COOLDOWN_MS optional, least time between two invitations to the same
//                                   person (default 1800000 = 30 min, 5 min..24 h)
//   QUICK_CONNECT_SEARCH_LIVENESS_MS optional, how long a search from an app that sends search heartbeats
//                                   stays matchable after its last heartbeat (default 30000, 15 s..120 s)
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
/**
 * The optional beta restriction. { restricted: false } only when the variable is unset or
 * blank; otherwise { restricted: true, ids } — and an all-malformed list leaves ids empty,
 * so nobody passes rather than everybody.
 */
function betaRestriction() {
  if (raw('QUICK_CONNECT_BETA_USER_IDS').trim() === '') return { restricted: false, ids: new Set() };
  return { restricted: true, ids: betaUserIds() };
}

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
/** Phase 2: a heartbeat-sending search with no heartbeat for this long is treated as gone (15–120 s). */
const searchLivenessMs = () => boundedMs('QUICK_CONNECT_SEARCH_LIVENESS_MS', 30000, 15000, 120000);
/** Phase 5: lifecycle sweeper period (5–60 s). Time limits are enforced within one period. */
const sweepIntervalMs = () => boundedMs('QUICK_CONNECT_SWEEP_INTERVAL_MS', 10000, 5000, 60000);
/** Most open Quick Connect sessions at once (capacity slots). Default = the validated baseline. */
const maxActiveCalls = () => boundedMs('QUICK_CONNECT_MAX_ACTIVE_CALLS', 10, 1, 500);
/** How long a "Notify me" request stays in the queue (10 min – 24 h). */
const waitlistTtlMs = () => boundedMs('QUICK_CONNECT_WAITLIST_TTL_MS', 2 * 60 * 60 * 1000, 10 * 60 * 1000, 24 * 60 * 60 * 1000);
/** After a skip (decline), how long the two people are not matched again (1 min – 24 h). */
const skipExclusionMs = () => boundedMs('QUICK_CONNECT_SKIP_EXCLUSION_MS', 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);

/** Smart Discovery invitations: off unless exactly "true" (and Quick Connect itself is on). */
const smartDiscoveryEnabled = () => isEnabled() && raw('QUICK_CONNECT_SMART_DISCOVERY_ENABLED').trim().toLowerCase() === 'true';
/** How long a search runs without a match before invitations are sent (10–90 s). */
const smartDiscoveryDelayMs = () => boundedMs('QUICK_CONNECT_SMART_DISCOVERY_DELAY_MS', 30000, 10000, 90000);
/** How long an invitation can be accepted (20 s – 3 min). */
const inviteTtlMs = () => boundedMs('QUICK_CONNECT_INVITE_TTL_MS', 60000, 20000, 180000);
/** Most invitations a single search sends (1–10). */
const invitesPerSearch = () => boundedMs('QUICK_CONNECT_INVITES_PER_SEARCH', 3, 1, 10);
/** Least time between two invitations to the same person (5 min – 24 h). */
const inviteCooldownMs = () => boundedMs('QUICK_CONNECT_INVITE_COOLDOWN_MS', 30 * 60 * 1000, 5 * 60 * 1000, 24 * 60 * 60 * 1000);

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
  betaRestriction,
  turnConfig,
  turnTtlSeconds,
  matchFallbackMs,
  searchTimeoutMs,
  searchLivenessMs,
  sweepIntervalMs,
  skipExclusionMs,
  maxActiveCalls,
  waitlistTtlMs,
  smartDiscoveryEnabled,
  smartDiscoveryDelayMs,
  inviteTtlMs,
  invitesPerSearch,
  inviteCooldownMs,
  CONSENT_VERSION_PATTERN,
  DEFAULT_TURN_URIS,
  MIN_SECRET_LENGTH,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS
};
