const AppConfig = require('../models/AppConfig');
const redisService = require('../services/redisService');

const CACHE_KEY = 'humrah:app-config';
const CACHE_TTL = parseInt(process.env.APP_CONFIG_CACHE_TTL || '900', 10);

const getAppConfig = async (req, res) => {
  const startTime = Date.now();
  try {
    // 1. Attempt Cache Read
    try {
      const cachedData = await redisService.get(CACHE_KEY);
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

    // 3. Attempt Cache Write
    try {
      await redisService.set(CACHE_KEY, responseData, CACHE_TTL);
      console.log(`APP_CONFIG_CACHE_SET (${Date.now() - startTime}ms overall, MongoDB took ${mongoDuration}ms)`);
    } catch (cacheSetError) {
      console.warn('APP_CONFIG_REDIS_ERROR (SET):', cacheSetError.message);
    }

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
