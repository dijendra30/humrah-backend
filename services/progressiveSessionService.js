const crypto = require('crypto');
const redisService = require('./redisService');

const PROGRESSIVE_SESSION_TTL_SECONDS = parseInt(process.env.PROGRESSIVE_SESSION_TTL_SECONDS, 10) || 1800; // 30 minutes

/**
 * Creates a new cryptographically random continuation token bound to the userId.
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<string>} token
 */
const createContinuationToken = async (userId) => {
  if (!userId) throw new Error('userId is required to create a continuation token');
  const token = crypto.randomBytes(32).toString('hex');
  const key = `progressive:session:${token}`;
  const now = Date.now();
  const sessionData = {
    userId: String(userId),
    createdAt: now,
    expiresAt: now + (PROGRESSIVE_SESSION_TTL_SECONDS * 1000)
  };
  await redisService.set(key, sessionData, PROGRESSIVE_SESSION_TTL_SECONDS);
  return token;
};

/**
 * Verifies that the continuation token exists, is not expired, and belongs to the given userId.
 * @param {string} token
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<boolean>}
 */
const verifyContinuationToken = async (token, userId) => {
  if (!token || typeof token !== 'string' || !userId) return false;
  const key = `progressive:session:${token}`;
  const session = await redisService.get(key);
  if (!session || typeof session !== 'object') return false;
  if (session.userId !== String(userId)) return false;
  if (session.expiresAt && Date.now() > session.expiresAt) {
    await redisService.del(key);
    return false;
  }
  return true;
};

/**
 * Invalidates the given continuation token.
 * @param {string} token
 */
const invalidateContinuationToken = async (token) => {
  if (token && typeof token === 'string') {
    await redisService.del(`progressive:session:${token}`);
  }
};

/**
 * Rotates an existing continuation token by invalidating the old one and issuing a fresh one.
 * @param {string|null} oldToken
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<string>} newToken
 */
const rotateContinuationToken = async (oldToken, userId) => {
  if (oldToken && typeof oldToken === 'string') {
    await invalidateContinuationToken(oldToken);
  }
  return createContinuationToken(userId);
};

module.exports = {
  createContinuationToken,
  verifyContinuationToken,
  invalidateContinuationToken,
  rotateContinuationToken,
  PROGRESSIVE_SESSION_TTL_SECONDS
};
