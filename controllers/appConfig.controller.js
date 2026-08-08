const AppConfig = require('../models/AppConfig');

const getAppConfig = async (req, res) => {
  try {
    let configDoc = await AppConfig.findOne({});
    
    // Fallback to env vars if no document exists yet
    let logoUrl = configDoc ? configDoc.logoUrl : process.env.HUMRAH_LOGO_URL;
    let logoVersion = configDoc ? configDoc.logoVersion : parseInt(process.env.HUMRAH_LOGO_VERSION || '1', 10);

    if (logoUrl) {
      return res.status(200).json({
        success: true,
        config: {
          logoUrl,
          logoVersion
        }
      });
    } else {
      return res.status(200).json({
        success: true,
        config: null
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
