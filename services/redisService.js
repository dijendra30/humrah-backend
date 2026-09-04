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

exports.getClient = () => redisClient;
