// middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');
const MongoStore = require('rate-limit-mongo');

// General API rate limiter
const apiLimiter = rateLimit({
  store: new MongoStore({
    uri: process.env.MONGODB_URI,
    collectionName: 'rateLimits',
    expireTimeMs: 15 * 60 * 1000 // 15 minutes
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for auth routes
const authLimiter = rateLimit({
  store: new MongoStore({
    uri: process.env.MONGODB_URI,
    collectionName: 'authRateLimits',
    expireTimeMs: 15 * 60 * 1000
  }),
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 login attempts per 15 minutes
  skipSuccessfulRequests: true, // Don't count successful logins
  message: 'Too many login attempts, please try again later.',
});

// OTP rate limiter
const otpLimiter = rateLimit({
  store: new MongoStore({
    uri: process.env.MONGODB_URI,
    collectionName: 'otpRateLimits',
    expireTimeMs: 60 * 60 * 1000
  }),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 OTP requests per hour
  message: 'Too many OTP requests. Please try again later.',
});

module.exports = { apiLimiter, authLimiter, otpLimiter };
