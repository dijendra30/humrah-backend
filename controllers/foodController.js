// controllers/foodController.js
// HTTP handlers for Food Discovery Posts — thin layer over foodService.js

const foodService = require('../services/foodService');
const { uploadBuffer } = require('../config/cloudinary'); // reuse existing Cloudinary config

// ─────────────────────────────────────────────────────────────
// POST /food/create
// ─────────────────────────────────────────────────────────────
/**
 * Create a new food discovery post.
 * Body (multipart/form-data):
 *   image       — required, food photo file
 *   caption     — optional, max 120 chars
 *   placeId     — required, Google Place ID
 *   placeName   — required
 *   latitude    — required
 *   longitude   — required
 *   priceRange  — optional, one of ₹ | ₹₹ | ₹₹₹
 *   city        — required (resolved client-side from Place details)
 */
const createPost = async (req, res) => {
  try {
    const { caption, placeId, placeName, latitude, longitude, priceRange, city } = req.body;

    // ── Validate required fields ──────────────────────────────
    if (!placeId || !placeName || !latitude || !longitude || !city) {
      return res.status(400).json({
        success: false,
        message: 'Place details are required (placeId, placeName, latitude, longitude, city)',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'A food photo is required',
      });
    }

    // ── Upload image to Cloudinary ────────────────────────────
    const uploadResult = await uploadBuffer(req.file.buffer, {
      folder:         'humrah/food_posts',
      transformation: [{ width: 1080, height: 1080, crop: 'limit', quality: 'auto' }],
    });

    // ── Delegate to service ───────────────────────────────────
    const post = await foodService.createFoodPost({
      userId:     req.userId,
      imageUrl:   uploadResult.secure_url,
      caption,
      placeId,
      placeName,
      latitude:   parseFloat(latitude),
      longitude:  parseFloat(longitude),
      priceRange: priceRange || null,
      city,
    });

    return res.status(201).json({
      success: true,
      message: 'Food discovery shared! 🍜',
      post,
    });
  } catch (error) {
    console.error('createPost error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to create food post',
    });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /food/nearby?city=delhi&page=1&limit=10
// ─────────────────────────────────────────────────────────────
/**
 * Return food posts within user's city, paginated, newest first.
 */
const getNearby = async (req, res) => {
  try {
    const { city, page = 1, limit = 10 } = req.query;

    if (!city) {
      return res.status(400).json({ success: false, message: 'city query param is required' });
    }

    const result = await foodService.getNearbyFoodPosts({
      city,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 20), // cap at 20
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('getNearby error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch nearby posts' });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /food/feed-cards?city=delhi
// ─────────────────────────────────────────────────────────────
/**
 * Returns exactly 3 fresh food cards for the horizontal feed section.
 * Used by the Android feed to inject the "Food discoveries near you" row.
 */
const getFeedCards = async (req, res) => {
  try {
    const { city } = req.query;

    if (!city) {
      return res.status(400).json({ success: false, message: 'city query param is required' });
    }

    const posts = await foodService.getFeedFoodCards({
      city,
      requestingUserId: req.userId,
    });

    return res.json({ success: true, posts });
  } catch (error) {
    console.error('getFeedCards error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch feed cards' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /food/like
// ─────────────────────────────────────────────────────────────
/**
 * Toggle like on a food post.
 * Body: { postId }
 */
const likePost = async (req, res) => {
  try {
    const { postId } = req.body;

    if (!postId) {
      return res.status(400).json({ success: false, message: 'postId is required' });
    }

    const result = await foodService.toggleLike({ postId, userId: req.userId });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('likePost error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to like post',
    });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /food/comment
// ─────────────────────────────────────────────────────────────
/**
 * Add a comment to a food post.
 * Body: { postId, text }
 */
const addComment = async (req, res) => {
  try {
    const { postId, text } = req.body;

    if (!postId || !text) {
      return res.status(400).json({ success: false, message: 'postId and text are required' });
    }

    const comment = await foodService.addComment({ postId, userId: req.userId, text });

    return res.status(201).json({ success: true, comment });
  } catch (error) {
    console.error('addComment error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to add comment',
    });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /food/comments/:postId?page=1
// ─────────────────────────────────────────────────────────────
/**
 * Get paginated comments for a post.
 */
const getComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const { page = 1 } = req.query;

    const result = await foodService.getComments({ postId, page: parseInt(page) });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('getComments error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to fetch comments',
    });
  }
};

module.exports = { createPost, getNearby, getFeedCards, likePost, addComment, getComments };
