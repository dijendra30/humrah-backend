const rateLimit = require('express-rate-limit');

const getUserId = (req, res) => {
  const uid = req.userId?.toString() || req.user?._id?.toString();
  return uid ? `uid:${uid}` : 'anonymous';
};

const lettersWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  keyGenerator: getUserId,
  message: {
    success: false,
    message: 'Too many requests to the Letters API. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const lettersReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  keyGenerator: getUserId,
  message: {
    success: false,
    message: 'Too many read requests to the Letters API. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  lettersWriteLimiter,
  lettersReadLimiter
};
