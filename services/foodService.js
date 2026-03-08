// services/foodService.js
// Business logic for Food Discovery Posts
// All DB queries live here — controllers stay thin

const FoodPost = require('../models/FoodPost');

// ─── Constants ────────────────────────────────────────────────
const MAX_POSTS_PER_WEEK = 3;
const FEED_CARD_LIMIT    = 3;   // Max cards shown in horizontal section
const NEARBY_RADIUS_KM   = 50;  // "Nearby" = same city (city-level, not geo-radius)

// ─── Helper: check weekly post limit ─────────────────────────
const checkWeeklyLimit = async (userId) => {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const count = await FoodPost.countDocuments({
    userId,
    createdAt: { $gte: oneWeekAgo },
    isActive: true,
  });
  return count >= MAX_POSTS_PER_WEEK;
};

// ─── Helper: sanitize caption for business promo ──────────────
const sanitizeCaption = (caption) => {
  if (!caption) return '';

  // Remove URLs
  let clean = caption.replace(/https?:\/\/[^\s]+/gi, '');
  // Remove phone numbers
  clean = clean.replace(/(\+?\d[\s\-\.]?){7,}/g, '');
  // Trim and enforce length
  return clean.trim().slice(0, 120);
};

// ─── Service: Create a food discovery post ───────────────────
const createFoodPost = async ({ userId, imageUrl, caption, placeId, placeName, latitude, longitude, priceRange, city }) => {
  // 1. Enforce weekly post limit (anti-spam)
  const limitReached = await checkWeeklyLimit(userId);
  if (limitReached) {
    const err = new Error(`You can only share ${MAX_POSTS_PER_WEEK} food discoveries per week. Come back later!`);
    err.statusCode = 429;
    throw err;
  }

  // 2. Sanitize caption (strip links and phone numbers)
  const cleanCaption = sanitizeCaption(caption);

  // 3. Create and persist the post
  const post = await FoodPost.create({
    userId,
    imageUrl,
    caption: cleanCaption,
    placeId,
    placeName,
    latitude,
    longitude,
    priceRange: priceRange || null,
    city: city.toLowerCase().trim(),
  });

  return post.populate('userId', 'firstName lastName profilePhoto');
};

// ─── Service: Get nearby food posts (same city, newest first) ─
const getNearbyFoodPosts = async ({ city, page = 1, limit = 10, excludeUserId = null }) => {
  const skip = (page - 1) * limit;

  const query = {
    city: city.toLowerCase().trim(),
    isActive: true,
    expiresAt: { $gt: new Date() }, // not yet expired
  };

  // Optionally exclude the requesting user's own posts (for feed variety)
  if (excludeUserId) {
    query.userId = { $ne: excludeUserId };
  }

  const posts = await FoodPost.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('userId', 'firstName lastName profilePhoto')
    .lean();

  const total = await FoodPost.countDocuments(query);

  return {
    posts,
    pagination: {
      page,
      limit,
      total,
      hasMore: skip + posts.length < total,
    },
  };
};

// ─── Service: Get 3 fresh cards for horizontal feed section ───
const getFeedFoodCards = async ({ city, requestingUserId }) => {
  const posts = await FoodPost.find({
    city: city.toLowerCase().trim(),
    isActive: true,
    expiresAt: { $gt: new Date() },
    userId: { $ne: requestingUserId }, // don't show user their own posts in feed
  })
    .sort({ createdAt: -1 })
    .limit(FEED_CARD_LIMIT)
    .populate('userId', 'firstName lastName profilePhoto')
    .lean();

  return posts;
};

// ─── Service: Like / Unlike a post (toggle) ───────────────────
const toggleLike = async ({ postId, userId }) => {
  const post = await FoodPost.findById(postId);
  if (!post || !post.isActive) {
    const err = new Error('Post not found');
    err.statusCode = 404;
    throw err;
  }

  const alreadyLiked = post.likes.some((id) => id.toString() === userId.toString());

  if (alreadyLiked) {
    post.likes.pull(userId);
  } else {
    post.likes.addToSet(userId);
  }

  post.likesCount = post.likes.length;
  await post.save();

  return {
    liked: !alreadyLiked,
    likesCount: post.likesCount,
  };
};

// ─── Service: Add a comment ───────────────────────────────────
const addComment = async ({ postId, userId, text }) => {
  if (!text || text.trim().length === 0) {
    const err = new Error('Comment text is required');
    err.statusCode = 400;
    throw err;
  }

  const post = await FoodPost.findById(postId);
  if (!post || !post.isActive) {
    const err = new Error('Post not found');
    err.statusCode = 404;
    throw err;
  }

  const comment = { userId, text: text.trim().slice(0, 200) };
  post.comments.push(comment);
  post.commentsCount = post.comments.length;
  await post.save();

  // Return the newly added comment (last item)
  const saved = post.comments[post.comments.length - 1];
  await post.populate('comments.userId', 'firstName lastName profilePhoto');

  const populated = post.comments.id(saved._id);
  return populated;
};

// ─── Service: Get comments for a post ────────────────────────
const getComments = async ({ postId, page = 1, limit = 20 }) => {
  const post = await FoodPost.findById(postId)
    .select('comments commentsCount isActive')
    .populate('comments.userId', 'firstName lastName profilePhoto');

  if (!post || !post.isActive) {
    const err = new Error('Post not found');
    err.statusCode = 404;
    throw err;
  }

  // Manual pagination on the comments array (newest last)
  const all      = post.comments;
  const start    = (page - 1) * limit;
  const paginated = all.slice(start, start + limit);

  return {
    comments: paginated,
    total: post.commentsCount,
    hasMore: start + paginated.length < all.length,
  };
};

module.exports = {
  createFoodPost,
  getNearbyFoodPosts,
  getFeedFoodCards,
  toggleLike,
  addComment,
  getComments,
};
