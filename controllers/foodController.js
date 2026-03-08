// controllers/foodController.js
const FoodPost   = require('../models/FoodPost');
const { uploadBuffer } = require('../config/cloudinary');
const { checkWeeklyLimit, sanitizeCaption, getFeedFoodCards, getNearbyFoodPosts, toggleLike, addComment, getComments } = require('../services/foodService');

// ─── POST /api/food/create ────────────────────────────────────
exports.createPost = async (req, res) => {
  try {
    const userId = req.userId;

    // ── 1. Image is required ──────────────────────────────────
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Food photo is required' });
    }

    // ── 2. Weekly limit ───────────────────────────────────────
    const limitReached = await checkWeeklyLimit(userId);
    if (limitReached) {
      return res.status(429).json({
        success: false,
        message: 'You\'ve reached your 3 food discovery limit for this week. Try again next week! 🍜'
      });
    }

    // ── 3. Upload to Cloudinary ───────────────────────────────
    let imageUrl = '';
    let imagePublicId = '';

    try {
      const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/food_posts');
      imageUrl      = uploadResult.url      || '';
      imagePublicId = uploadResult.publicId || '';
    } catch (uploadErr) {
      console.error('❌ Cloudinary upload failed:', uploadErr);
      return res.status(500).json({ success: false, message: 'Image upload failed. Please try again.' });
    }

    if (!imageUrl) {
      return res.status(500).json({ success: false, message: 'Image upload returned no URL. Please try again.' });
    }

    // ── 4. Sanitize caption ───────────────────────────────────
    const { caption, placeId, placeName, latitude, longitude, priceRange, city } = req.body;
    const cleanCaption = sanitizeCaption(caption || '');

    // ── 5. Create post ────────────────────────────────────────
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const post = await FoodPost.create({
      userId,
      imageUrl,
      imagePublicId,
      caption:    cleanCaption,
      placeId:    placeId    || '',
      placeName:  placeName  || '',
      latitude:   parseFloat(latitude)  || 0,
      longitude:  parseFloat(longitude) || 0,
      city:       (city || '').toLowerCase().trim(),
      priceRange: priceRange || null,
      expiresAt,
    });

    await post.populate('userId', 'firstName lastName profilePhoto');

    res.status(201).json({ success: true, message: 'Food discovery shared! 🍜', post });

  } catch (err) {
    console.error('createPost error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
};

// ─── GET /api/food/feed-cards ─────────────────────────────────
exports.getFeedCards = async (req, res) => {
  try {
    const { city } = req.query;
    const posts = await getFeedFoodCards(city, req.userId);
    res.json({ success: true, posts });
  } catch (err) {
    console.error('getFeedCards error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET /api/food/nearby ─────────────────────────────────────
exports.getNearby = async (req, res) => {
  try {
    const { city, page = 1, limit = 20 } = req.query;
    const posts = await getNearbyFoodPosts(city, req.userId, parseInt(page), parseInt(limit));
    res.json({ success: true, posts });
  } catch (err) {
    console.error('getNearby error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/food/like ──────────────────────────────────────
exports.likePost = async (req, res) => {
  try {
    const { postId } = req.body;
    const result = await toggleLike(postId, req.userId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('likePost error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/food/comment ───────────────────────────────────
exports.addComment = async (req, res) => {
  try {
    const { postId, text } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }
    const comment = await addComment(postId, req.userId, text.trim());
    res.status(201).json({ success: true, comment });
  } catch (err) {
    console.error('addComment error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET /api/food/comments/:postId ──────────────────────────
exports.getComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const result = await getComments(postId, parseInt(page), parseInt(limit));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('getComments error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
