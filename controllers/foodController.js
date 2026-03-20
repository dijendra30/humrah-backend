// controllers/foodController.js
// PATCHED: added Activity + Push hooks after likePost and addComment.
// All other code is identical to the original.

const FoodPost  = require('../models/FoodPost');
const FoodComment = require('../models/FoodCommentModel');
const { getPlaceDetails } = require('../services/googlePlaceService');
const { uploadBuffer }    = require('../config/cloudinary');

// ── Activity + Push helpers (lazy require — avoids circular deps) ──
const getActivity = () => require('./activityController').createOrAggregateActivity;
const getPush     = () => require('../utils/gamingPush').sendGamingPush;

// ── Daily post limit ──────────────────────────────────────────
async function dailyPostCount(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return FoodPost.countDocuments({ userId, createdAt: { $gte: startOfDay }, isActive: true });
}

// ══════════════════════════════════════════════════════════════
//  POST /food/create
// ══════════════════════════════════════════════════════════════
exports.createPost = async (req, res) => {
  try {
    const userId = req.userId;
    if (!req.file) return res.status(400).json({ success: false, message: 'Image is required' });

    const todayCount = await dailyPostCount(userId);
    if (todayCount >= 3) {
      return res.status(429).json({
        success: false,
        message: 'You can only share 3 food discoveries per day.',
      });
    }

    const {
      caption    = '',
      placeId    = '',
      placeName  = '',
      latitude,
      longitude,
      priceRange = null,
      city,
      placeRating,
    } = req.body;

    if (!latitude || !longitude || !city) {
      return res.status(400).json({ success: false, message: 'latitude, longitude and city are required' });
    }

    // Upload image to Cloudinary
    const { url: imageUrl, publicId: imagePublicId } = await uploadBuffer(
      req.file.buffer,
      'humrah/food'
    );

    let finalPlaceName   = placeName || null;
    let finalRating      = placeRating ? parseFloat(placeRating) : null;
    let finalRatingCount = null;
    let finalLat         = parseFloat(latitude);
    let finalLng         = parseFloat(longitude);

    // Fetch Google Place details if placeId provided
    if (placeId) {
      const details = await getPlaceDetails(placeId);
      if (details.placeName) finalPlaceName   = details.placeName;
      if (details.rating)    finalRating      = details.rating;
      if (details.userRatingCount) finalRatingCount = details.userRatingCount;
      if (details.latitude)  finalLat         = details.latitude;
      if (details.longitude) finalLng         = details.longitude;
    }

    const post = await FoodPost.create({
      userId,
      imageUrl,
      imagePublicId,
      caption:         caption.trim().slice(0, 120),
      placeId:         placeId || null,
      placeName:       finalPlaceName,
      latitude:        finalLat,
      longitude:       finalLng,
      priceRange:      priceRange || null,
      city:            city.toLowerCase().trim(),
      rating:          finalRating,
      userRatingCount: finalRatingCount,
    });

    await post.populate('userId', 'firstName lastName profilePhoto');

    res.status(201).json({ success: true, message: 'Food post created!', post });
  } catch (err) {
    console.error('[Food] createPost:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/feed-cards  — up to 3 fresh cards for community feed
// ══════════════════════════════════════════════════════════════
exports.getFeedCards = async (req, res) => {
  try {
    const city = (req.query.city || req.user?.questionnaire?.city || '').toLowerCase().trim();
    if (!city) return res.status(400).json({ success: false, message: 'city is required' });

    const requestingUserId = req.userId;

    // Try fresh posts first (< 24h)
    let posts = await FoodPost.find({
      city,
      isActive:  true,
      expiresAt: { $gt: new Date() },
      userId:    { $ne: requestingUserId },
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    })
      .sort({ createdAt: -1 })
      .limit(3)
      .populate('userId', 'firstName lastName profilePhoto')
      .lean();

    // Fall back to any active posts if fewer than 3 fresh ones
    if (posts.length < 3) {
      const freshIds = posts.map(p => p._id);
      const older = await FoodPost.find({
        city,
        isActive:  true,
        expiresAt: { $gt: new Date() },
        userId:    { $ne: requestingUserId },
        _id:       { $nin: freshIds },
      })
        .sort({ createdAt: -1 })
        .limit(3 - posts.length)
        .populate('userId', 'firstName lastName profilePhoto')
        .lean();
      posts = [...posts, ...older];
    }

    res.json({ success: true, posts });
  } catch (err) {
    console.error('[Food] getFeedCards:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/nearby — full paginated feed
// ══════════════════════════════════════════════════════════════
exports.getNearby = async (req, res) => {
  try {
    const city      = (req.query.city || req.user?.questionnaire?.city || '').toLowerCase().trim();
    const page      = Math.max(1, parseInt(req.query.page) || 1);
    const limit     = 10;
    const skip      = (page - 1) * limit;
    const latitude  = parseFloat(req.query.latitude)  || null;
    const longitude = parseFloat(req.query.longitude) || null;

    if (!city) return res.status(400).json({ success: false, message: 'city is required' });

    const RADIUS_KM = 15;
    let posts;

    if (latitude && longitude) {
      // Step 1: geo-filter within 15 km
      const geoIds = await FoodPost.find({
        location: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [longitude, latitude] },
            $maxDistance: RADIUS_KM * 1000,
          },
        },
        city,
        isActive:  true,
        expiresAt: { $gt: new Date() },
      })
        .select('_id')
        .lean();

      const ids = geoIds.map(p => p._id);

      // Step 2: sort by newest
      posts = await FoodPost.find({ _id: { $in: ids } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName profilePhoto')
        .lean();
    } else {
      posts = await FoodPost.find({
        city,
        isActive:  true,
        expiresAt: { $gt: new Date() },
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName profilePhoto')
        .lean();
    }

    const total = await FoodPost.countDocuments({
      city,
      isActive:  true,
      expiresAt: { $gt: new Date() },
    });

    res.json({
      success: true,
      posts,
      pagination: { page, limit, total, hasMore: skip + posts.length < total },
    });
  } catch (err) {
    console.error('[Food] getNearby:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getFoodPosts = exports.getNearby;

// ══════════════════════════════════════════════════════════════
//  POST /food/like
//  ✅ ACTIVITY HOOK: creates LIKE_FOOD activity (no push per spec)
// ══════════════════════════════════════════════════════════════
exports.likePost = async (req, res) => {
  try {
    const { postId } = req.body;
    const userId = req.userId.toString();

    const post = await FoodPost.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const alreadyLikedIdx = post.likes.findIndex((id) => id.toString() === userId);
    const liked = alreadyLikedIdx === -1;

    if (liked) {
      post.likes.push(req.userId);
    } else {
      post.likes.splice(alreadyLikedIdx, 1);
    }
    post.likesCount = post.likes.length;
    await post.save();

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

    // ── ✅ Activity: LIKE_FOOD — no push per spec ──────────────
    if (liked && post.userId.toString() !== userId) {
      getActivity()({
        userId:      post.userId,
        actorId:     req.userId,
        type:        'LIKE_FOOD',
        entityType:  'food_post',
        entityId:    post._id,
        entityImage: post.imageUrl,
      }).catch(e => console.error('[Activity] LIKE_FOOD:', e.message));
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  POST /food/comment
//  ✅ ACTIVITY HOOK: creates COMMENT_FOOD activity + push per spec
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

    // ── ✅ Activity: COMMENT_FOOD + push (per spec) ────────────
    if (post.userId.toString() !== req.userId.toString()) {
      const actorName = `${comment.userId.firstName} ${comment.userId.lastName || ''}`.trim();

      // Activity feed entry
      getActivity()({
        userId:      post.userId,
        actorId:     req.userId,
        type:        'COMMENT_FOOD',
        entityType:  'food_post',
        entityId:    post._id,
        entityImage: post.imageUrl,
        message:     `${actorName} commented on your food post`,
      }).catch(e => console.error('[Activity] COMMENT_FOOD:', e.message));

      // Push notification
      getPush()({
        recipientId: post.userId,
        title:       '💬 New comment on your food post',
        body:        `${actorName}: "${text.trim().slice(0, 60)}"`,
        data: {
          type:     'COMMENT_FOOD',
          entityId: post._id.toString(),
          postId:   postId.toString(),
        },
      }).catch(e => console.error('[ActivityPush] COMMENT_FOOD:', e.message));
    }
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
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip  = (page - 1) * limit;

    const [comments, total] = await Promise.all([
      FoodComment.find({ postId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName profilePhoto')
        .lean(),
      FoodComment.countDocuments({ postId }),
    ]);

    res.json({ success: true, comments, total, hasMore: skip + comments.length < total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/:id  — fetch single post by ID (used by push notification tap)
// ══════════════════════════════════════════════════════════════
exports.getPostById = async (req, res) => {
  try {
    const post = await FoodPost.findById(req.params.id)
      .populate('userId', 'firstName lastName profilePhoto')
      .lean();
    if (!post || !post.isActive) {
      return res.status(404).json({ success: false, message: 'Post not found or expired' });
    }
    res.json({ success: true, post });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
//  GET /food/test-places — dev helper
// ══════════════════════════════════════════════════════════════
exports.testPlaces = async (req, res) => {
  const { placeId } = req.query;
  if (!placeId) return res.status(400).json({ success: false, message: 'placeId required' });
  const details = await getPlaceDetails(placeId);
  res.json({ success: true, details });
};
