const FoodPost    = require('../models/FoodPost');
const FoodComment = require('../models/FoodCommentModel');
const { uploadBuffer } = require('../config/cloudinary');
const https = require('https');

const MAX_POSTS_PER_DAY = 2;
const FEED_CARD_LIMIT   = 3;
const NEARBY_RADIUS_KM  = 15;
const PLACES_API_KEY    = process.env.GOOGLE_PLACES_API_KEY || '';

// ─── Daily post count ─────────────────────────────────────────
async function dailyPostCount(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return FoodPost.countDocuments({ userId, createdAt: { $gte: startOfDay }, isActive: true });
}

// ─── Haversine distance (km) ──────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Caption sanitizer ────────────────────────────────────────
function sanitize(caption = '') {
  return caption
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(\+?\d[\d\s\-().]{7,}\d)/g, '')
    .trim()
    .slice(0, 120);
}

// ─── Google Places New API — fetch rating ─────────────────────
// Uses the Places API v1 (new) with placeId
// Returns a number (e.g. 4.3) or null if unavailable
async function fetchPlaceRating(placeId) {
  if (!PLACES_API_KEY || !placeId) return null;
  return new Promise((resolve) => {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=rating&key=${PLACES_API_KEY}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(typeof json.rating === 'number' ? json.rating : null);
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// ══════════════════════════════════════════════════════════════
//  POST /food/create
// ══════════════════════════════════════════════════════════════
exports.createPost = async (req, res) => {
  try {
    const userId = req.userId;
    if (!req.file) return res.status(400).json({ success: false, message: 'Food photo is required' });

    const todayCount = await dailyPostCount(userId);
    if (todayCount >= MAX_POSTS_PER_DAY) {
      return res.status(429).json({
        success: false,
        message: "You've reached your 2 food post limit for today. Come back tomorrow! 🍜",
      });
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
    const lat = parseFloat(latitude)  || 0;
    const lng = parseFloat(longitude) || 0;

    // Fetch Google Places rating for this stall (non-blocking — null if API fails)
    const placeRating = await fetchPlaceRating(placeId);

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours

    const post = await FoodPost.create({
      userId,
      imageUrl,
      imagePublicId,
      caption:     sanitize(caption),
      placeId:     placeId   || '',
      placeName:   placeName || '',
      latitude:    lat,
      longitude:   lng,
      location:    { type: 'Point', coordinates: [lng, lat] }, // GeoJSON [lng, lat]
      city:        (city || '').toLowerCase().trim(),
      priceRange:  priceRange || null,
      placeRating: placeRating,
      expiresAt,
    });

    await post.populate('userId', 'firstName lastName profilePhoto');
    res.status(201).json({ success: true, message: 'Food discovery shared! 🍜', post });

  } catch (err) {
    console.error('createPost error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/feed-cards
// ══════════════════════════════════════════════════════════════
exports.getFeedCards = async (req, res) => {
  try {
    const { city } = req.query;
    const normalizedCity = (city || '').toLowerCase().trim();
    const filter = { isActive: true, expiresAt: { $gt: new Date() } };
    if (normalizedCity && normalizedCity !== 'all') filter.city = normalizedCity;

    const posts = await FoodPost.find(filter)
      .sort({ createdAt: -1 })
      .limit(FEED_CARD_LIMIT)
      .populate('userId', 'firstName lastName profilePhoto');

    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/nearby   — 15 km radius via $nearSphere
// ══════════════════════════════════════════════════════════════
exports.getNearby = async (req, res) => {
  try {
    const { latitude, longitude, city, page = 1, limit = 20 } = req.query;
    const userLat  = parseFloat(latitude);
    const userLng  = parseFloat(longitude);
    const hasCoords = !isNaN(userLat) && !isNaN(userLng);

    let posts;
    if (hasCoords) {
      posts = await FoodPost.find({
        isActive:  true,
        expiresAt: { $gt: new Date() },
        location: {
          $nearSphere: {
            $geometry:    { type: 'Point', coordinates: [userLng, userLat] },
            $maxDistance: NEARBY_RADIUS_KM * 1000,
          },
        },
      })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate('userId', 'firstName lastName profilePhoto');
    } else {
      const filter = { isActive: true, expiresAt: { $gt: new Date() } };
      if (city) filter.city = city.toLowerCase().trim();
      posts = await FoodPost.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate('userId', 'firstName lastName profilePhoto');
    }

    const postsWithDistance = posts.map((post) => {
      const obj = post.toObject();
      if (hasCoords) {
        obj.distanceKm = parseFloat(
          haversineKm(userLat, userLng, post.latitude, post.longitude).toFixed(1)
        );
      }
      return obj;
    });

    res.json({ success: true, posts: postsWithDistance });
  } catch (err) {
    console.error('getNearby error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  POST /food/like
//  FIX: ObjectId comparison must use .toString()
//  NEW: emits FOOD_POST_LIKED socket event for real-time UI
// ══════════════════════════════════════════════════════════════
exports.likePost = async (req, res) => {
  try {
    const { postId } = req.body;
    const userId = req.userId.toString();

    const post = await FoodPost.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    // ✅ FIX: use .toString() comparison — ObjectId === ObjectId is always false
    const alreadyLikedIdx = post.likes.findIndex((id) => id.toString() === userId);
    const liked = alreadyLikedIdx === -1;

    if (liked) {
      post.likes.push(req.userId);
    } else {
      post.likes.splice(alreadyLikedIdx, 1);
    }
    post.likesCount = post.likes.length;
    await post.save();

    // ✅ Real-time: broadcast to everyone watching this food post room
    const io = req.app.get('io');
    if (io) {
      io.to(`food_post_${postId}`).emit('FOOD_POST_LIKED', {
        postId,
        likesCount: post.likesCount,
        liked,
        likedBy: userId,
      });
    }

    res.json({ success: true, liked, likesCount: post.likesCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  POST /food/comment
//  NEW: emits FOOD_NEW_COMMENT socket event for real-time UI
// ══════════════════════════════════════════════════════════════
exports.addComment = async (req, res) => {
  try {
    const { postId, text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Comment text is required' });
    if (text.trim().length > 120) return res.status(400).json({ success: false, message: 'Comment cannot exceed 120 characters' });

    const post = await FoodPost.findById(postId);
    if (!post || !post.isActive) return res.status(404).json({ success: false, message: 'Post not found' });

    const comment = await FoodComment.create({
      postId,
      userId: req.userId,
      text:   text.trim(),
    });
    await FoodPost.findByIdAndUpdate(postId, { $inc: { commentsCount: 1 } });
    await comment.populate('userId', 'firstName lastName profilePhoto');

    // ✅ Real-time: broadcast new comment to the post room
    const io = req.app.get('io');
    if (io) {
      io.to(`food_post_${postId}`).emit('FOOD_NEW_COMMENT', {
        postId,
        comment: {
          _id:       comment._id.toString(),
          text:      comment.text,
          createdAt: comment.createdAt,
          userId: {
            _id:          comment.userId._id,
            firstName:    comment.userId.firstName,
            lastName:     comment.userId.lastName,
            profilePhoto: comment.userId.profilePhoto,
          },
        },
      });
    }

    res.status(201).json({ success: true, comment });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/comments/:postId
// ══════════════════════════════════════════════════════════════
exports.getComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const comments = await FoodComment.find({ postId })
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate('userId', 'firstName lastName profilePhoto');
    const total = await FoodComment.countDocuments({ postId });
    res.json({ success: true, comments, total, hasMore: total > parseInt(page) * parseInt(limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
