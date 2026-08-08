const AppConfig = require('../models/AppConfig');

const getAppConfig = async (req, res) => {
  try {
    let configDoc = await AppConfig.findOne({});
    
    if (configDoc && configDoc.branding) {
      return res.status(200).json({
        success: true,
        config: {
          branding: configDoc.branding
        }
      });
    } else {
      // Fallback if no document or old document
      return res.status(200).json({
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
      });
    }
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
