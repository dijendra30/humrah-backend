const AppConfig = require('../models/AppConfig');
const { uploadBuffer } = require('../config/cloudinary');

// GET /api/admin/branding
const getBranding = async (req, res) => {
  try {
    const config = await AppConfig.findOne({});
    return res.status(200).json({
      success: true,
      data: {
        logoUrl: config?.logoUrl || '',
        logoVersion: config?.logoVersion || 1,
        draftLogoUrl: config?.draftLogoUrl || '',
        draftCreatedAt: config?.draftCreatedAt || null,
        publishedAt: config?.publishedAt || null,
        publishedBy: config?.publishedBy || null
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

    // Validation
    const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Unsupported file format' });
    }

    if (req.file.size > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'File too large. Maximum 2MB' });
    }

    // Upload to Cloudinary
    const result = await uploadBuffer(req.file.buffer, 'humrah-branding');

    // Upsert AppConfig to store draft
    let config = await AppConfig.findOne({});
    if (!config) {
      config = new AppConfig();
    }
    
    config.draftLogoUrl = result.url;
    config.draftCreatedAt = new Date();
    await config.save();

    return res.status(200).json({
      success: true,
      message: 'Logo uploaded as draft',
      draftLogoUrl: config.draftLogoUrl
    });
  } catch (error) {
    console.error('Error uploading logo:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload logo' });
  }
};

// POST /api/admin/branding/publish
const publishLogo = async (req, res) => {
  try {
    let config = await AppConfig.findOne({});
    if (!config || !config.draftLogoUrl) {
      return res.status(400).json({ success: false, message: 'No draft logo to publish' });
    }

    config.logoUrl = config.draftLogoUrl;
    config.logoVersion += 1;
    config.publishedAt = new Date();
    config.publishedBy = req.user?._id || null;
    
    // Clear draft
    config.draftLogoUrl = '';
    config.draftCreatedAt = null;

    await config.save();

    return res.status(200).json({
      success: true,
      message: 'Logo published successfully',
      data: {
        logoUrl: config.logoUrl,
        logoVersion: config.logoVersion,
        publishedAt: config.publishedAt
      }
    });
  } catch (error) {
    console.error('Error publishing logo:', error);
    return res.status(500).json({ success: false, message: 'Failed to publish logo' });
  }
};

module.exports = {
  getBranding,
  uploadLogo,
  publishLogo
};
