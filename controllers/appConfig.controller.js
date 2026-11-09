const AppConfig = require('../models/AppConfig');
const redisService = require('../services/redisService');

const CACHE_KEY = 'humrah:app-config';
const CACHE_TTL = parseInt(process.env.APP_CONFIG_CACHE_TTL || '900', 10);
// The app calls this at launch; a slow or unreachable Redis must never delay it. A read that
// takes longer than this falls through to MongoDB (same path as a Redis error).
const CACHE_READ_TIMEOUT_MS = parseInt(process.env.APP_CONFIG_CACHE_READ_TIMEOUT_MS || '250', 10);

// Stall-aware: times out a slow Redis, but not a reply delayed only by this process being busy.
const { withTimeout } = require('../services/cacheService');

const getAppConfig = async (req, res) => {
  const startTime = Date.now();
  try {
    // 1. Attempt Cache Read (skipped while Redis is known to be disconnected)
    try {
      if (redisService.isAvailable && !redisService.isAvailable()) throw new Error('Redis not connected');
      const cachedData = await withTimeout(redisService.get(CACHE_KEY), CACHE_READ_TIMEOUT_MS);
      if (cachedData) {
        console.log(`APP_CONFIG_CACHE_HIT (${Date.now() - startTime}ms)`);
        return res.status(200).json(cachedData);
      }
      console.log(`APP_CONFIG_CACHE_MISS`);
    } catch (cacheError) {
      console.warn('APP_CONFIG_REDIS_ERROR (GET):', cacheError.message);
      console.log('APP_CONFIG_MONGO_FALLBACK');
    }

    // 2. Fetch from MongoDB
    const mongoStartTime = Date.now();
    let configDoc = await AppConfig.findOne({});
    const mongoDuration = Date.now() - mongoStartTime;
    
    let responseData;
    if (configDoc && configDoc.branding) {
      responseData = {
        success: true,
        config: {
          branding: configDoc.branding
        }
      };
    } else {
      // Fallback if no document or old document
      responseData = {
        success: true,
        config: {
          branding: {
            remoteBrandingEnabled: false,
            launcher: {
              mode: 'DEFAULT',
              variantId: null
            },
            splash: {
              enabled: false,
              logoUrl: process.env.HUMRAH_LOGO_URL || null,
              version: parseInt(process.env.HUMRAH_LOGO_VERSION || '1', 10)
            },
            activeVersion: 1
          }
        }
      };
    }

    // 3. Attempt Cache Write — not awaited, so a failing Redis cannot delay the response.
    if (redisService.isAvailable && !redisService.isAvailable()) return res.status(200).json(responseData);
    Promise.resolve()
      .then(() => redisService.set(CACHE_KEY, responseData, CACHE_TTL))
      .then(() => console.log(`APP_CONFIG_CACHE_SET (${Date.now() - startTime}ms overall, MongoDB took ${mongoDuration}ms)`))
      .catch((cacheSetError) => console.warn('APP_CONFIG_REDIS_ERROR (SET):', cacheSetError.message));

    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Error fetching app config:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch app configuration'
    });
  }
};

module.exports = {
  getAppConfig
};
