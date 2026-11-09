// services/legalVersionCache.js — process-local cache of the current Terms/Privacy versions.
//
// Why: every authenticated request runs enforceLegalAcceptance, which read both LegalVersion
// documents from MongoDB (2 queries, ~1 ms CPU each) — and because several /api mounts stack
// the middleware, a single request often did it 2–3 times. The two documents are tiny, global
// (not per user) and change only when an operator runs scripts/initLegalVersions.js.
//
// Why process-local and not Redis: a Redis round trip costs about the same as the Mongo read it
// would replace; an in-process value costs nothing. The data is not user-specific, so there is
// no cross-user leakage risk.
//
// Consistency: a new legal version is enforced within LEGAL_VERSION_CACHE_TTL_MS (default 60 s)
// on every instance. Set LEGAL_VERSION_CACHE_TTL_MS=0 to disable caching (old behaviour).
// A missing document is NEVER cached, so "Legal versions not configured" is re-checked each call.
'use strict';

const mongoose = require('mongoose');

const DEFAULT_TTL_MS = 60 * 1000;
let cached = null;      // { terms: { currentVersion, url }, privacy: {...}, expiresAt }
let inflight = null;    // single-flight: concurrent misses share one read

function ttlMs() {
  const raw = process.env.LEGAL_VERSION_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

async function readFromDb() {
  const LegalVersion = mongoose.model('LegalVersion');
  const [terms, privacy] = await Promise.all([
    LegalVersion.findOne({ documentType: 'TERMS' }).select('currentVersion url').lean(),
    LegalVersion.findOne({ documentType: 'PRIVACY' }).select('currentVersion url').lean(),
  ]);
  return {
    terms: terms ? { currentVersion: terms.currentVersion, url: terms.url } : null,
    privacy: privacy ? { currentVersion: privacy.currentVersion, url: privacy.url } : null,
  };
}

/**
 * Current legal versions: { terms: {currentVersion, url} | null, privacy: {...} | null }.
 * Returned objects are frozen copies — callers must not mutate them.
 */
async function getCurrentLegalVersions() {
  const ttl = ttlMs();
  if (ttl === 0) return readFromDb();
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!inflight) {
    inflight = readFromDb()
      .then((value) => {
        if (value.terms && value.privacy) {
          const frozen = Object.freeze({ terms: Object.freeze(value.terms), privacy: Object.freeze(value.privacy) });
          cached = { value: frozen, expiresAt: Date.now() + ttl };
          return frozen;
        }
        cached = null; // never cache a misconfiguration
        return value;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Drop the cached value (tests; or call after changing LegalVersion in-process). */
function invalidateLegalVersions() { cached = null; }

module.exports = { getCurrentLegalVersions, invalidateLegalVersions };
