// controllers/foodController.js
// All business logic for Food Discovery Posts
//
// FIXES applied vs previous version:
//  • Spam limit: 3/week → 2/day            (spec §17)
//  • expiresAt:  30 days → 4 hours         (spec §2)
//  • getNearby:  city-string → Haversine 15 km radius (spec §4, §5)
//  • addComment: now writes to separate FoodComment collection (spec §8)
//  • getComments: reads from FoodComment collection (spec §8)

const FoodPost        = require('../models/FoodPost');
const FoodComment     = require('../models/FoodCommentModel');
const { uploadBuffer } = require('../config/cloudinary');

const MAX_POSTS_PER_DAY = 2;   // spec §17: max 2 per user per day
const FEED_CARD_LIMIT   = 3;
const NEARBY_RADIUS_KM  = 15;  // spec §4: 15 km radius

// ─── Helper: count today's posts for a user ───────────────────
async function dailyPostCount(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0); // midnight local → UTC-safe enough for rate limiting
  return FoodPost.countDocuments({
    userId,
    createdAt: { $gte: startOfDay },
    isActive: true,
  });
}

// ─── Helper: Haversine distance (km) between two lat/lng points ─
// Returns distance in kilometres.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R   = 6371;                          // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return (deg * Math.PI) / 180; }

// ─── Helper: sanitize caption ─────────────────────────────────
function sanitize(caption = '') {
  return caption
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(\+?\d[\d\s\-().]{7,}\d)/g, '')
    .trim()
    .slice(0, 120);
}

// ══════════════════════════════════════════════════════════════
//  POST /food/create
// ══════════════════════════════════════════════════════════════
exports.createPost = async (req, res) => {
  try {
    const userId = req.userId;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Food photo is required' });
    }

    // ✅ Rate limit: 2 posts per day (spec §17)
    const todayCount = await dailyPostCount(userId);
    if (todayCount >= MAX_POSTS_PER_DAY) {
      return res.status(429).json({
        success: false,
        message: "You've reached your 2 food post limit for today. Come back tomorrow! 🍜",
      });
    }

    // Upload image to Cloudinary
    let imageUrl = '', imagePublicId = '';
    try {
      const result  = await uploadBuffer(req.file.buffer, 'humrah/food_posts');
      imageUrl      = result.url      || '';
      imagePublicId = result.publicId || '';
    } catch (uploadErr) {
      console.error('❌ Cloudinary upload failed:', uploadErr);
      return res.status(500).json({ success: false, message: 'Image upload failed. Please try again.' });
    }
    if (!imageUrl) {
      return res.status(500).json({ success: false, message: 'Image upload returned no URL.' });
    }

    const { caption, placeId, placeName, latitude, longitude, priceRange, city } = req.body;
    const lat = parseFloat(latitude)  || 0;
    const lng = parseFloat(longitude) || 0;

    // ✅ expiresAt = now + 4 hours (spec §2)
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);

    const post = await FoodPost.create({
      userId,
      imageUrl,
      imagePublicId,
      caption:   sanitize(caption),
      placeId:   placeId   || '',
      placeName: placeName || '',
      latitude:  lat,
      longitude: lng,
      location:  { type: 'Point', coordinates: [lng, lat] }, // GeoJSON
      city:      (city || '').toLowerCase().trim(),
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

// ══════════════════════════════════════════════════════════════
//  GET /food/feed-cards   (3 cards for horizontal feed section)
// ══════════════════════════════════════════════════════════════
exports.getFeedCards = async (req, res) => {
  try {
    const { city } = req.query;
    const normalizedCity = (city || '').toLowerCase().trim();

    const filter = { isActive: true, expiresAt: { $gt: new Date() } };
    if (normalizedCity && normalizedCity !== 'all') {
      filter.city = normalizedCity;
    }

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
//  GET /food/nearby   (paginated, 15 km Haversine filter)
// ══════════════════════════════════════════════════════════════
exports.getNearby = async (req, res) => {
  try {
    const { latitude, longitude, city, page = 1, limit = 20 } = req.query;

    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);
    const hasCoords = !isNaN(userLat) && !isNaN(userLng);

    // ✅ Strategy: if lat/lng are provided, use MongoDB $nearSphere for radius query.
    // Fallback to city-string filter if no coordinates (e.g. older clients).
    let posts;

    if (hasCoords) {
      // ── $nearSphere — returns posts within 15 km, sorted by distance ──
      // Requires the 2dsphere index on FoodPost.location (added in FoodPost.js)
      posts = await FoodPost.find({
        isActive:  true,
        expiresAt: { $gt: new Date() },
        location:  {
          $nearSphere: {
            $geometry: {
              type:        'Point',
              coordinates: [userLng, userLat], // GeoJSON: [lng, lat]
            },
            $maxDistance: NEARBY_RADIUS_KM * 1000, // convert km → metres
          },
        },
      })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate('userId', 'firstName lastName profilePhoto');

    } else {
      // ── Fallback: city-string filter + Haversine post-filter ──────────
      const filter = { isActive: true, expiresAt: { $gt: new Date() } };
      if (city) filter.city = city.toLowerCase().trim();

      const allPosts = await FoodPost.find(filter)
        .sort({ createdAt: -1 })
        .populate('userId', 'firstName lastName profilePhoto');

      // Haversine post-filter (no coord info → skip distance filter)
      posts = allPosts.slice(
        (parseInt(page) - 1) * parseInt(limit),
        parseInt(page) * parseInt(limit),
      );
    }

    // Attach distanceKm to each post for the Android card label ("2.3 km away")
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
// ══════════════════════════════════════════════════════════════
exports.likePost = async (req, res) => {
  try {
    const { postId } = req.body;
    const post = await FoodPost.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const idx = post.likes.indexOf(req.userId);
    if (idx === -1) post.likes.push(req.userId);
    else post.likes.splice(idx, 1);
    post.likesCount = post.likes.length;
    await post.save();

    res.json({ success: true, liked: idx === -1, likesCount: post.likesCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  POST /food/comment
//  ✅ Writes to separate FoodComment collection (spec §8)
//     AND increments embedded commentsCount on FoodPost
// ══════════════════════════════════════════════════════════════
exports.addComment = async (req, res) => {
  try {
    const { postId, text } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }
    if (text.trim().length > 120) {
      return res.status(400).json({ success: false, message: 'Comment cannot exceed 120 characters' });
    }

    const post = await FoodPost.findById(postId);
    if (!post || !post.isActive) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    // Write to standalone FoodComment collection
    const comment = await FoodComment.create({
      postId,
      userId: req.userId,
      text:   text.trim(),
    });

    // Keep denormalized count on the post in sync
    await FoodPost.findByIdAndUpdate(postId, { $inc: { commentsCount: 1 } });

    // Populate author before responding
    await comment.populate('userId', 'firstName lastName profilePhoto');

    res.status(201).json({ success: true, comment });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/comments/:postId
//  ✅ Reads from separate FoodComment collection (spec §8)
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
