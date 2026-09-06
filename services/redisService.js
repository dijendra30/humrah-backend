const Redis = require('ioredis');

let redisClient = null;

try {
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    redisClient = new Redis(process.env.REDIS_URL || {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
    });
    console.log('[REDIS] Connected to Redis for Humrah Rooms');
  } else {
    console.warn('[REDIS] No Redis config found. Using memory fallback (Suitable for dev only).');
  }
} catch (error) {
  console.warn('[REDIS] Failed to initialize Redis', error);
}

// In-memory fallback if Redis is disabled/unavailable
const memCache = new Map();

exports.acquireLock = async (key, ttlSeconds = 10) => {
  if (redisClient) {
    const result = await redisClient.set(key, 'locked', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }
  if (memCache.has(key)) {
    const expires = memCache.get(key);
    if (Date.now() < expires) return false;
  }
  memCache.set(key, Date.now() + (ttlSeconds * 1000));
  return true;
};

exports.releaseLock = async (key) => {
  if (redisClient) {
    await redisClient.del(key);
  } else {
    memCache.delete(key);
  }
};

exports.set = async (key, value, ttlSeconds) => {
  if (redisClient) {
    if (ttlSeconds) {
      await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } else {
      await redisClient.set(key, JSON.stringify(value));
    }
  } else {
    memCache.set(key, { value, expires: ttlSeconds ? Date.now() + (ttlSeconds * 1000) : Infinity });
  }
};

exports.del = async (key) => {
  if (redisClient) {
    await redisClient.del(key);
  } else {
    memCache.delete(key);
  }
};

exports.setWithJitter = async (key, value, baseTtlSeconds, jitterSeconds) => {
  const jitter = Math.floor(Math.random() * (jitterSeconds * 2)) - jitterSeconds;
  const finalTtl = Math.max(1, baseTtlSeconds + jitter);
  if (redisClient) {
    await redisClient.set(key, JSON.stringify(value), 'EX', finalTtl);
  } else {
    memCache.set(key, { value, expires: Date.now() + (finalTtl * 1000) });
  }
};

/**
 * Fixed-window counter. Atomically increments `key` and, on the first hit of a
 * window, sets its TTL to `windowSeconds`. Returns the new count.
 *
 * Multi-instance safe when Redis is configured (INCR is atomic server-side).
 * Falls back to the in-memory map only when Redis is absent (dev). Callers that
 * use this for a security control should treat the in-memory path as best-effort.
 */
exports.incrementWithWindow = async (key, windowSeconds) => {
  if (redisClient) {
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, windowSeconds);
    }
    return count;
  }
  // in-memory fallback (dev only)
  const now = Date.now();
  const item = memCache.get(key);
  if (!item || now >= item.expires) {
    memCache.set(key, { value: 1, expires: now + windowSeconds * 1000 });
    return 1;
  }
  item.value += 1;
  return item.value;
};

exports.get = async (key) => {
  if (redisClient) {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  }
  if (memCache.has(key)) {
    const item = memCache.get(key);
    if (Date.now() < item.expires) return item.value;
    memCache.delete(key);
  }
  return null;
};

/**
 * Bulk read. Returns a Map of key -> parsed value for keys that exist.
 * Uses a single ioredis pipeline so N keys cost one round trip.
 * Falls back to the in-memory map when Redis is not configured (dev only).
 */
exports.getMany = async (keys) => {
  const out = new Map();
  if (!Array.isArray(keys) || keys.length === 0) return out;
  if (redisClient) {
    const pipeline = redisClient.pipeline();
    keys.forEach(k => pipeline.get(k));
    const results = await pipeline.exec();
    results.forEach(([err, val], i) => {
      if (!err && val != null) {
        try { out.set(keys[i], JSON.parse(val)); } catch (_) { out.set(keys[i], val); }
      }
    });
    return out;
  }
  const now = Date.now();
  keys.forEach(k => {
    const item = memCache.get(k);
    if (item && typeof item === 'object' && 'expires' in item) {
      if (now < item.expires) out.set(k, item.value);
      else memCache.delete(k);
    }
  });
  return out;
};

exports.getClient = () => redisClient;
