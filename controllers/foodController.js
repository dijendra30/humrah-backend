// controllers/foodController.js
// All business logic inlined — no dependency on foodService.js
const FoodPost      = require('../models/FoodPost');
const { uploadBuffer } = require('../config/cloudinary');

const MAX_POSTS_PER_WEEK = 3;
const FEED_CARD_LIMIT    = 3;

async function weeklyPostCount(userId) {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  return FoodPost.countDocuments({ userId, createdAt: { $gte: weekAgo } });
}

function sanitize(caption = '') {
  return caption
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(\+?\d[\d\s\-().]{7,}\d)/g, '')
    .trim()
    .slice(0, 120);
}

exports.createPost = async (req, res) => {
  try {
    const userId = req.userId;
    if (!req.file) return res.status(400).json({ success: false, message: 'Food photo is required' });

    const count = await weeklyPostCount(userId);
    if (count >= MAX_POSTS_PER_WEEK) {
      return res.status(429).json({ success: false, message: "You've reached your 3 food discovery limit for this week. Try again next week! 🍜" });
    }

    let imageUrl = '', imagePublicId = '';
    try {
      const result = await uploadBuffer(req.file.buffer, 'humrah/food_posts');
      imageUrl      = result.url      || '';
      imagePublicId = result.publicId || '';
    } catch (uploadErr) {
      console.error('❌ Cloudinary upload failed:', uploadErr);
      return res.status(500).json({ success: false, message: 'Image upload failed. Please try again.' });
    }

    if (!imageUrl) return res.status(500).json({ success: false, message: 'Image upload returned no URL.' });

    const { caption, placeId, placeName, latitude, longitude, priceRange, city } = req.body;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const post = await FoodPost.create({
      userId, imageUrl, imagePublicId,
      caption:    sanitize(caption),
      placeId:    placeId   || '',
      placeName:  placeName || '',
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

exports.getFeedCards = async (req, res) => {
  try {
    const { city } = req.query;
    const filter = { isActive: true, expiresAt: { $gt: new Date() }, userId: { $ne: req.userId } };
    if (city) filter.city = city.toLowerCase().trim();
    const posts = await FoodPost.find(filter).sort({ createdAt: -1 }).limit(FEED_CARD_LIMIT).populate('userId', 'firstName lastName profilePhoto');
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNearby = async (req, res) => {
  try {
    const { city, page = 1, limit = 20 } = req.query;
    const filter = { isActive: true, expiresAt: { $gt: new Date() } };
    if (city) filter.city = city.toLowerCase().trim();
    const posts = await FoodPost.find(filter).sort({ createdAt: -1 }).skip((parseInt(page)-1)*parseInt(limit)).limit(parseInt(limit)).populate('userId', 'firstName lastName profilePhoto');
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.likePost = async (req, res) => {
  try {
    const { postId } = req.body;
    const post = await FoodPost.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    const idx = post.likes.indexOf(req.userId);
    if (idx === -1) post.likes.push(req.userId); else post.likes.splice(idx, 1);
    post.likesCount = post.likes.length;
    await post.save();
    res.json({ success: true, liked: idx === -1, likesCount: post.likesCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.addComment = async (req, res) => {
  try {
    const { postId, text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Comment text is required' });
    const post = await FoodPost.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    post.comments.push({ userId: req.userId, text: text.trim() });
    post.commentsCount = post.comments.length;
    await post.save();
    res.status(201).json({ success: true, comment: post.comments[post.comments.length - 1] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const post = await FoodPost.findById(postId).populate('comments.userId', 'firstName lastName profilePhoto');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    const skip = (parseInt(page)-1)*parseInt(limit);
    res.json({ success: true, comments: post.comments.slice(skip, skip+parseInt(limit)), total: post.commentsCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
