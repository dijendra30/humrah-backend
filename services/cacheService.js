// services/cacheService.js — cache-aside helper on top of the EXISTING shared Redis client
// (services/redisService.js). It adds no new connection; when Redis is not configured it uses
// redisService's in-memory fallback, exactly like the rest of the codebase.
//
// What it adds over calling redisService.get/set directly:
//   • versioned, namespaced keys built only from validated parts   humrah:cache:v1:<ns>:<parts>
//   • a read timeout — a slow or hung Redis never holds a request; it is treated as a miss
//   • a circuit breaker — after repeated Redis failures the cache is bypassed for a cool-down,
//     so an outage costs one database read per request instead of a timeout per request
//   • single-flight — concurrent misses for the same key in this process share ONE load
//   • TTL jitter — keys written together do not all expire together
//   • optional stale-while-revalidate — serve the previous value while one refresh runs
//   • counters for hits / misses / stale / errors / bypasses / loads (see stats())
//
// Rules for callers (see PERFORMANCE_PHASE_4_1_CACHE_STRATEGY.md):
//   • cache only data that is safe to show to every caller who can produce the same key —
//     per-user data MUST include the user id in the key parts;
//   • never cache passwords, tokens, auth/permission decisions, private messages or precise
//     private location in shared keys;
//   • apply blocks / visibility / permission checks AFTER reading from the cache.
'use strict';

const redisService = require('./redisService');

const PREFIX = 'humrah:cache:v1';
const PART_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

const num = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const cfg = () => ({
  enabled: process.env.CACHE_ENABLED !== 'false',
  readTimeoutMs: num('CACHE_READ_TIMEOUT_MS', 500),
  breakerThreshold: num('CACHE_BREAKER_FAILURES', 5),
  breakerCooldownMs: num('CACHE_BREAKER_COOLDOWN_MS', 30000),
});

const counters = { hits: 0, misses: 0, stale: 0, errors: 0, bypassed: 0, loads: 0, loadErrors: 0, writes: 0 };
const breaker = { failures: 0, openUntil: 0 };
const inflight = new Map();

function buildKey(namespace, parts = []) {
  if (!PART_RE.test(namespace)) throw new Error('cacheService: invalid namespace');
  const list = Array.isArray(parts) ? parts : [parts];
  const safe = list.map((p) => {
    const s = String(p);
    if (!PART_RE.test(s)) throw new Error('cacheService: invalid key part');
    return s;
  });
  return [PREFIX, namespace, ...safe].join(':');
}

function breakerOpen() { return Date.now() < breaker.openUntil; }
function recordFailure() {
  counters.errors++;
  breaker.failures++;
  const { breakerThreshold, breakerCooldownMs } = cfg();
  if (breaker.failures >= breakerThreshold) {
    breaker.openUntil = Date.now() + breakerCooldownMs;
    breaker.failures = 0;
    console.warn(`[CACHE] Redis failing — cache bypassed for ${Math.round(breakerCooldownMs / 1000)}s`);
  }
}
function recordSuccess() { breaker.failures = 0; }

// Times out a Redis call — but only when REDIS is slow. If the timer itself fires late, this
// process's event loop was stalled (CPU-bound under load) and the reply may already be waiting
// to be processed; treating that as a Redis failure would turn cache hits into expensive
// recomputes exactly when the server is busiest, and could trip the breaker for a healthy
// Redis (observed in load testing). In that case keep waiting for the real reply, which the
// shared client's own command timeout (REDIS_COMMAND_TIMEOUT_MS) still bounds.
function withTimeout(promise, ms) {
  if (!ms) return promise;
  let t;
  const startedAt = Date.now();
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => {
        const lateBy = Date.now() - startedAt - ms;
        if (lateBy > ms / 2) {
          // Event-loop stall, not a slow Redis: give the reply a further bounded window.
          t = setTimeout(() => reject(new Error('cache read timeout')), Math.max(ms * 4, 2000));
          return;
        }
        reject(new Error('cache read timeout'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(t));
}

async function safeRead(key) {
  if (breakerOpen() || (redisService.isAvailable && !redisService.isAvailable())) { counters.bypassed++; return undefined; }
  try {
    const v = await withTimeout(redisService.get(key), cfg().readTimeoutMs);
    recordSuccess();
    return v;
  } catch (_) {
    recordFailure();
    return undefined; // treated as a miss
  }
}

function safeWrite(key, envelope, ttlSeconds, jitterSeconds) {
  if (breakerOpen() || (redisService.isAvailable && !redisService.isAvailable())) return;
  const p = jitterSeconds > 0
    ? redisService.setWithJitter(key, envelope, ttlSeconds, Math.min(jitterSeconds, Math.max(0, ttlSeconds - 1)))
    : redisService.set(key, envelope, ttlSeconds);
  counters.writes++;
  // Fire-and-forget: a failed write must never fail the request. Only a successful READ resets
  // the breaker — a Redis whose reads time out must still trip it even if writes land.
  Promise.resolve(p).then(() => {}, recordFailure);
}

function load(key, loader, ttlSeconds, opts) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    counters.loads++;
    try {
      const value = await loader();
      if (value !== undefined && (opts.cacheIf ? opts.cacheIf(value) : true)) {
        const softMs = opts.staleWhileRevalidateSeconds ? ttlSeconds * 1000 : 0;
        const storeTtl = ttlSeconds + (opts.staleWhileRevalidateSeconds || 0);
        safeWrite(key, { v: value, s: softMs ? Date.now() + softMs : 0 }, storeTtl, opts.jitterSeconds ?? Math.ceil(ttlSeconds * 0.1));
      }
      return value;
    } catch (err) {
      counters.loadErrors++;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Cache-aside read.
 * @param {string} namespace  e.g. 'app-config'
 * @param {Array<string|number>} parts  validated key parts (include the user id for per-user data)
 * @param {number} ttlSeconds  freshness window
 * @param {() => Promise<any>} loader  source-of-truth read; its result must be JSON-serialisable
 * @param {object} [opts]  { staleWhileRevalidateSeconds, jitterSeconds, cacheIf(value) }
 */
async function getOrLoad(namespace, parts, ttlSeconds, loader, opts = {}) {
  if (!cfg().enabled) return loader();
  const key = buildKey(namespace, parts);
  const env = await safeRead(key);
  if (env && typeof env === 'object' && 'v' in env) {
    if (env.s && Date.now() > env.s) {
      counters.stale++;
      load(key, loader, ttlSeconds, opts).catch(() => {}); // background refresh, single-flight
      return env.v;
    }
    counters.hits++;
    return env.v;
  }
  counters.misses++;
  return load(key, loader, ttlSeconds, opts);
}

/** Remove one cached entry (call from every write path that changes the source data). */
async function invalidate(namespace, parts) {
  const key = buildKey(namespace, parts);
  try { await withTimeout(redisService.del(key), cfg().readTimeoutMs * 4); } catch (_) { recordFailure(); }
}

function stats() {
  return { ...counters, breakerOpen: breakerOpen(), inflight: inflight.size };
}

/** Test helper. */
function _reset() {
  Object.keys(counters).forEach((k) => { counters[k] = 0; });
  breaker.failures = 0; breaker.openUntil = 0; inflight.clear();
}

module.exports = { getOrLoad, invalidate, buildKey, stats, withTimeout, _reset };
