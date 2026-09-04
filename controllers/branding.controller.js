const AppConfig = require('../models/AppConfig');
const { uploadBuffer } = require('../config/cloudinary');
const redisService = require('../services/redisService');

const CACHE_KEY = 'humrah:app-config';

const getOrCreateConfig = async () => {
  let config = await AppConfig.findOne({});
  if (!config) {
    config = new AppConfig();
    await config.save();
  } else if (config.logoUrl !== undefined) {
    // Trigger migration hook
    await config.save();
  }
  return config;
};

// GET /api/admin/branding
const getBranding = async (req, res) => {
  try {
    const config = await getOrCreateConfig();
    return res.status(200).json({
      success: true,
      config: {
        branding: config.branding,
        draft: config.draft
      }
    });
  } catch (error) {
    console.error('Error fetching branding:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch branding config' });
  }
};

// POST /api/admin/branding/logo (Requires multipart upload middleware)
const uploadLogo = async (req, res) => {
  try {
    console.log("Upload request received");
    console.log("req.file:", req.file ? {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
    } : null);

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }

    const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Unsupported file format' });
    }

    if (req.file.size > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'File too large. Maximum 2MB' });
    }

    const result = await uploadBuffer(req.file.buffer, 'humrah-branding');

    let config = await getOrCreateConfig();
    
    config.draft.splashLogoUrl = result.url;
    config.draft.createdAt = new Date();
    await config.save();

    return res.status(200).json({
      success: true,
      message: 'Splash logo uploaded as draft',
      draftLogoUrl: config.draft.splashLogoUrl
    });
  } catch (error) {
    console.error('Error uploading logo:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload logo' });
  }
};

// POST /api/admin/branding/publish
const publishLogo = async (req, res) => {
  try {
    let config = await getOrCreateConfig();
    if (!config.draft || !config.draft.splashLogoUrl) {
      return res.status(400).json({ success: false, message: 'No draft logo to publish' });
    }

    config.branding.remoteBrandingEnabled = true;
    config.branding.splash.enabled = true;
    config.branding.splash.logoUrl = config.draft.splashLogoUrl;
    config.branding.splash.version = config.branding.activeVersion + 1;
    config.branding.activeVersion += 1;
    config.branding.updatedAt = new Date();
    
    // Clear draft
    config.draft.splashLogoUrl = null;
    config.draft.createdAt = null;

    await config.save();
    
    // Invalidate Cache
    try {
      await redisService.del(CACHE_KEY);
      console.log('APP_CONFIG_CACHE_INVALIDATED');
    } catch (err) {
      console.warn('Failed to invalidate cache:', err.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Logo published successfully',
      config: {
        branding: config.branding
      }
    });
  } catch (error) {
    console.error('Error publishing logo:', error);
    return res.status(500).json({ success: false, message: 'Failed to publish logo' });
  }
};

// POST /api/admin/branding/stop
const stopRemoteBranding = async (req, res) => {
  try {
    let config = await getOrCreateConfig();
    config.branding.remoteBrandingEnabled = false;
    config.branding.updatedAt = new Date();
    await config.save();

    // Invalidate Cache
    try {
      await redisService.del(CACHE_KEY);
      console.log('APP_CONFIG_CACHE_INVALIDATED');
    } catch (err) {
      console.warn('Failed to invalidate cache:', err.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Remote branding stopped',
      config: {
        branding: config.branding
      }
    });
  } catch (error) {
    console.error('Error stopping remote branding:', error);
    return res.status(500).json({ success: false, message: 'Failed to stop remote branding' });
  }
};

// POST /api/admin/branding/restore-default
const restoreDefaultBranding = async (req, res) => {
  try {
    let config = await getOrCreateConfig();
    config.branding.remoteBrandingEnabled = false;
    config.branding.launcher.mode = 'DEFAULT';
    config.branding.launcher.variantId = null;
    config.branding.splash.enabled = false;
    config.branding.splash.logoUrl = null;
    config.branding.activeVersion += 1;
    config.branding.splash.version = config.branding.activeVersion;
    config.branding.updatedAt = new Date();
    
    config.draft.splashLogoUrl = null;
    config.draft.createdAt = null;

    await config.save();

    // Invalidate Cache
    try {
      await redisService.del(CACHE_KEY);
      console.log('APP_CONFIG_CACHE_INVALIDATED');
    } catch (err) {
      console.warn('Failed to invalidate cache:', err.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Restored default branding',
      config: {
        branding: config.branding
      }
    });
  } catch (error) {
    console.error('Error restoring default branding:', error);
    return res.status(500).json({ success: false, message: 'Failed to restore default branding' });
  }
};

// POST /api/admin/branding/delete-draft
const deleteDraft = async (req, res) => {
  try {
    let config = await getOrCreateConfig();
    config.draft.splashLogoUrl = null;
    config.draft.createdAt = null;
    await config.save();

    return res.status(200).json({
      success: true,
      message: 'Draft deleted',
      config: {
        branding: config.branding,
        draft: config.draft
      }
    });
  } catch (error) {
    console.error('Error deleting draft:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete draft' });
  }
};

module.exports = {
  getBranding,
  uploadLogo,
  publishLogo,
  stopRemoteBranding,
  restoreDefaultBranding,
  deleteDraft
};
