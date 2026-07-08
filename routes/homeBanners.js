const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const HomeBanner = require('../models/HomeBanner');
const { auth, adminOnly } = require('../middleware/auth');

const { uploadBase64, deleteImage } = require('../config/cloudinary');

// ============================================================================
// LIGHTWEIGHT DEDUPLICATION & VALIDATION UTILS
// ============================================================================

const recentInteractions = new Map();

function isDuplicateInteraction(bannerId, identifier, type) {
  const key = `${bannerId}_${identifier}_${type}`;
  const now = Date.now();
  if (recentInteractions.has(key)) {
    const lastTime = recentInteractions.get(key);
    if (now - lastTime < 3600000) return true; // 1 hour window
  }
  recentInteractions.set(key, now);
  if (recentInteractions.size > 10000) recentInteractions.clear();
  return false;
}

function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// ============================================================================
// PUBLIC/USER ROUTES
// ============================================================================

// GET /api/home-banners/active
// Fetches only active banners whose publishDate has passed and expiryDate has not
router.get('/active', async (req, res) => {
  try {
    const now = new Date();
    const banners = await HomeBanner.find({
      isActive: true,
      publishDate: { $lte: now },
      expiryDate: { $gt: now }
    })
      .sort({ displayOrder: 1, publishDate: -1 })
      .lean();

    res.json({ success: true, banners });
  } catch (error) {
    console.error('Error fetching active banners:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/home-banners/:id/impression
// Record an impression
router.post('/:id/impression', async (req, res) => {
  try {
    const identifier = req.userId || req.ip || 'unknown';
    if (isDuplicateInteraction(req.params.id, identifier, 'impression')) {
      return res.json({ success: true, message: 'Duplicate impression ignored' });
    }

    const banner = await HomeBanner.findById(req.params.id);
    if (!banner) return res.status(404).json({ success: false });

    banner.impressions += 1;
    banner.lastViewedAt = new Date();
    await banner.save(); // triggers pre-save to calc CTR

    console.log(`[BANNER IMPRESSION] ID: ${banner._id} | Title: ${banner.title} | By: ${identifier}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error logging banner impression:', error);
    res.status(500).json({ success: false });
  }
});

// POST /api/home-banners/:id/click
// Record a click
router.post('/:id/click', async (req, res) => {
  try {
    const identifier = req.userId || req.ip || 'unknown';
    if (isDuplicateInteraction(req.params.id, identifier, 'click')) {
      return res.json({ success: true, message: 'Duplicate click ignored' });
    }

    const banner = await HomeBanner.findById(req.params.id);
    if (!banner) return res.status(404).json({ success: false });

    banner.clicks += 1;
    banner.lastClickedAt = new Date();
    await banner.save(); // triggers pre-save to calc CTR

    console.log(`[BANNER CLICK] ID: ${banner._id} | Title: ${banner.title} | By: ${identifier}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error logging banner click:', error);
    res.status(500).json({ success: false });
  }
});

// ============================================================================
// ADMIN ROUTES
// ============================================================================

// GET /api/home-banners/admin
// Fetch all banners with dashboard metrics
router.get('/admin', auth, adminOnly, async (req, res) => {
  try {
    const banners = await HomeBanner.find()
      .sort({ displayOrder: 1, createdAt: -1 })
      .populate('createdBy', 'firstName lastName')
      .populate('updatedBy', 'firstName lastName')
      .lean();

    const now = new Date();
    
    // Calculate metrics
    let active = 0;
    let scheduled = 0;
    let expired = 0;

    banners.forEach(b => {
      const pDate = new Date(b.publishDate);
      const eDate = new Date(b.expiryDate);
      if (!b.isActive) {
        // Just inactive
      } else if (pDate > now) {
        scheduled++;
      } else if (eDate < now) {
        expired++;
      } else {
        active++;
      }
    });

    res.json({ 
      success: true, 
      metrics: { total: banners.length, active, scheduled, expired },
      banners 
    });
  } catch (error) {
    console.error('Error fetching admin banners:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/home-banners/admin
// Create new banner
router.post('/admin', auth, adminOnly, async (req, res) => {
  try {
    const { 
      title, subtitle, bannerImageBase64, actionType, actionValue, 
      displayOrder, publishDate, expiryDate, isActive 
    } = req.body;
    
    if (!bannerImageBase64) {
        return res.status(400).json({ success: false, message: 'Banner image is required' });
    }

    if (actionType === 'Open URL' && actionValue) {
        if (!isValidUrl(actionValue)) {
            return res.status(400).json({ success: false, message: 'Invalid URL. Only secure https:// URLs are allowed.' });
        }
    }

    // Upload to Cloudinary
    const uploadResult = await uploadBase64(bannerImageBase64, 'home_banners');
    if (!uploadResult) {
        return res.status(500).json({ success: false, message: 'Failed to upload image' });
    }

    const banner = new HomeBanner({
      title, subtitle, 
      bannerImage: uploadResult.url, 
      bannerImagePublicId: uploadResult.publicId,
      actionType, actionValue,
      displayOrder: displayOrder || 0,
      publishDate, expiryDate, isActive,
      createdBy: req.userId,
      updatedBy: req.userId
    });

    await banner.save();
    console.log(`[BANNER CREATED] ID: ${banner._id} | Title: ${banner.title} | By User: ${req.userId}`);
    res.status(201).json({ success: true, banner });
  } catch (error) {
    console.error('Error creating banner:', error);
    res.status(500).json({ success: false, message: 'Failed to create banner' });
  }
});

// PUT /api/home-banners/admin/:id
// Update banner
router.put('/admin/:id', auth, adminOnly, async (req, res) => {
  try {
    const { 
      title, subtitle, bannerImageBase64, actionType, actionValue, 
      displayOrder, publishDate, expiryDate, isActive 
    } = req.body;

    const banner = await HomeBanner.findById(req.params.id);
    if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });

    if (actionType === 'Open URL' && actionValue) {
        if (!isValidUrl(actionValue)) {
            return res.status(400).json({ success: false, message: 'Invalid URL. Only secure https:// URLs are allowed.' });
        }
    }

    if (bannerImageBase64) {
        // Delete old image if it exists
        if (banner.bannerImagePublicId) {
            await deleteImage(banner.bannerImagePublicId);
        }
        // Upload new image
        const uploadResult = await uploadBase64(bannerImageBase64, 'home_banners');
        if (uploadResult) {
            banner.bannerImage = uploadResult.url;
            banner.bannerImagePublicId = uploadResult.publicId;
        }
    }

    if (title !== undefined) banner.title = title;
    if (subtitle !== undefined) banner.subtitle = subtitle;
    if (actionType !== undefined) banner.actionType = actionType;
    if (actionValue !== undefined) banner.actionValue = actionValue;
    if (displayOrder !== undefined) banner.displayOrder = displayOrder;
    if (publishDate !== undefined) banner.publishDate = publishDate;
    if (expiryDate !== undefined) banner.expiryDate = expiryDate;
    if (isActive !== undefined) banner.isActive = isActive;
    
    banner.updatedBy = req.userId;

    await banner.save(); // triggers CTR calc if needed
    console.log(`[BANNER UPDATED] ID: ${banner._id} | Title: ${banner.title} | By User: ${req.userId}`);
    res.json({ success: true, banner });
  } catch (error) {
    console.error('Error updating banner:', error);
    res.status(500).json({ success: false, message: 'Failed to update banner' });
  }
});

// DELETE /api/home-banners/admin/:id
// Delete banner
router.delete('/admin/:id', auth, adminOnly, async (req, res) => {
  try {
    const banner = await HomeBanner.findById(req.params.id);
    if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });
    
    if (banner.bannerImagePublicId) {
        await deleteImage(banner.bannerImagePublicId);
    }
    
    await banner.deleteOne();
    console.log(`[BANNER DELETED] ID: ${banner._id} | Title: ${banner.title} | By User: ${req.userId}`);
    res.json({ success: true, message: 'Banner deleted successfully' });
  } catch (error) {
    console.error('Error deleting banner:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/home-banners/admin/reorder
// Reorder banners
router.put('/admin/reorder', auth, adminOnly, async (req, res) => {
  try {
    const { orderedIds } = req.body; // Array of banner IDs in correct order
    
    if (!orderedIds || !Array.isArray(orderedIds)) {
      return res.status(400).json({ success: false, message: 'orderedIds array required' });
    }

    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { displayOrder: index, updatedBy: req.userId } }
      }
    }));

    if (bulkOps.length > 0) {
      await HomeBanner.bulkWrite(bulkOps);
    }

    console.log(`[BANNERS REORDERED] By User: ${req.userId}`);
    res.json({ success: true, message: 'Banners reordered' });
  } catch (error) {
    console.error('Error reordering banners:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/home-banners/admin/:id/duplicate
// Duplicate banner
router.post('/admin/:id/duplicate', auth, adminOnly, async (req, res) => {
  try {
    const existing = await HomeBanner.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Banner not found' });

    delete existing._id;
    delete existing.createdAt;
    delete existing.updatedAt;
    existing.title = `${existing.title} (Copy)`;
    existing.impressions = 0;
    existing.clicks = 0;
    existing.ctr = 0;
    existing.lastViewedAt = null;
    existing.lastClickedAt = null;
    existing.isActive = false; // Duplicates start as inactive (Draft)
    existing.createdBy = req.userId;
    existing.updatedBy = req.userId;

    const banner = new HomeBanner(existing);
    await banner.save();

    console.log(`[BANNER DUPLICATED] New ID: ${banner._id} | From: ${req.params.id} | By User: ${req.userId}`);
    res.status(201).json({ success: true, banner });
  } catch (error) {
    console.error('Error duplicating banner:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
