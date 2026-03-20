// routes/posts.js — Feed + Like + Comment system (v2)
// Replaces the old embedded-array approach with dedicated collections.
const express  = require('express');
const router   = express.Router();
const rateLimit = require('express-rate-limit');

const { auth }                    = require('../middleware/auth');
const { enforceImageModeration }  = require('../middleware/imageModerationMiddleware');
const Post                        = require('../models/Post');
const PostLike                    = require('../models/PostLike');
const Comment                     = require('../models/Comment');
const CommentLike                 = require('../models/CommentLike');
const User                        = require('../models/User');
const { cloudinary, uploadBase64, deleteImage } = require('../config/cloudinary');

// ─────────────────────────────────────────────────────────────
//  RATE LIMITERS
// ─────────────────────────────────────────────────────────────

// Comment limiter: max 10 comments per minute per user
const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.userId,
  message: { success: false, message: 'Too many comments. Slow down! 🐢' }
});

// Like limiter: max 30 likes per minute (prevents rapid toggle spam)
const likeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.userId,
  message: { success: false, message: 'Too many like requests. Slow down! 🐢' }
});

// ─────────────────────────────────────────────────────────────
//  POST CREATION
//  POST /api/posts
// ─────────────────────────────────────────────────────────────

router.post('/', auth, enforceImageModeration, async (req, res) => {
  try {
    const {
      imageBase64, caption, location,
      disappearMode, disappearHours, vibeMode,
      allowComments, allowLikes, onlyFollowers,
      hasPoll, pollQuestion, pollOptions
    } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'Image is required' });
    }

    const uploadResult = await uploadBase64(
      imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`,
      'humrah/posts'
    );

    if (!uploadResult?.url || !uploadResult?.publicId) {
      return res.status(500).json({ success: false, message: 'Image upload failed' });
    }

    // Backfill publicId into moderation audit log
    try {
      const user = await User.findById(req.userId);
      if (user?.imageModerationLog?.length) {
        const last = user.imageModerationLog[user.imageModerationLog.length - 1];
        if (last.action === 'ALLOWED' && !last.imagePublicId) {
          last.imagePublicId = uploadResult.publicId;
          await user.save();
        }
      }
    } catch (_) {}

    let parsedPollOptions = [];
    if (hasPoll === 'true' && pollOptions) {
      const arr = typeof pollOptions === 'string'
        ? pollOptions.split(',').filter(o => o.trim())
        : pollOptions;
      parsedPollOptions = arr.map(o => ({ optionText: o.trim(), votes: [] }));
    }

    const post = new Post({
      userId:        req.userId,
      imageUrl:      uploadResult.url,
      imagePublicId: uploadResult.publicId,
      caption:       caption || '',
      location:      location || null,
      likeCount:     0,
      commentCount:  0,
      disappearMode: disappearMode || 'PERMANENT',
      disappearHours: disappearHours ? parseInt(disappearHours) : null,
      vibeMode:      vibeMode || 'NORMAL',
      allowComments: allowComments === 'true',
      allowLikes:    allowLikes === 'true',
      onlyFollowers: onlyFollowers === 'true',
      hasPoll:       hasPoll === 'true',
      pollQuestion:  pollQuestion || null,
      pollOptions:   parsedPollOptions
    });

    await post.save();
    await post.populate('userId', 'firstName lastName profilePhoto');

    // ── Socket: broadcast new post to all connected users ─────
    const io = req.app.get('io');
    if (io) {
      io.emit('NEW_POST', { post });
    }

    res.status(201).json({
      success: true,
      message: 'Post created successfully ✨',
      post,
      moderation: { passed: true, scores: req.moderationResult?.scores || {} }
    });

  } catch (error) {
    console.error('🔥 Create post error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  CURSOR-BASED FEED
//  GET /api/posts/feed?cursor=<ISO>&limit=15
//
//  First load: omit cursor
//  Load more:  cursor = createdAt of OLDEST post on screen
//  Returns:    { posts, nextCursor, hasMore }
// ─────────────────────────────────────────────────────────────

router.get('/feed', auth, async (req, res) => {
  try {
    const limit      = Math.min(parseInt(req.query.limit) || 15, 30);
    const cursor     = req.query.cursor; // ISO 8601 or undefined

    const query = { isActive: true };

    // Cursor filter: only posts OLDER than the cursor timestamp
    if (cursor) {
      query.createdAt = { $lt: new Date(cursor) };
    }

    const posts = await Post.find(query)
      .populate('userId', 'firstName lastName profilePhoto')
      .sort({ createdAt: -1 })
      .limit(limit + 1); // fetch one extra to determine hasMore

    const hasMore  = posts.length > limit;
    const result   = hasMore ? posts.slice(0, limit) : posts;

    // Filter expired disappearing posts
    const visible = result.filter(p => {
      if (p.disappearMode !== 'PERMANENT' && p.expiresAt) {
        if (new Date() > p.expiresAt) return false;
      }
      return true;
    });

    // Attach per-user like status if userId provided
    const userId = req.userId;
    const postIds = visible.map(p => p._id);

    // Bulk fetch current user's likes for these posts (1 query)
    const userLikes = await PostLike.find({
      userId: userId,
      postId: { $in: postIds }
    }).select('postId');
    const likedSet = new Set(userLikes.map(l => l.postId.toString()));

    const enriched = visible.map(p => ({
      ...p.toObject(),
      isLikedByMe: likedSet.has(p._id.toString())
    }));

    const nextCursor = hasMore && result.length > 0
      ? result[result.length - 1].createdAt.toISOString()
      : null;

    res.json({
      success:    true,
      posts:      enriched,
      nextCursor,
      hasMore
    });

  } catch (error) {
    console.error('Feed error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  USER POSTS
//  GET /api/posts/user/:userId
// ─────────────────────────────────────────────────────────────

router.get('/user/:userId', auth, async (req, res) => {
  try {
    const posts = await Post.find({ userId: req.params.userId, isActive: true })
      .populate('userId', 'firstName lastName profilePhoto')
      .sort({ createdAt: -1 });

    const visible = posts.filter(p => {
      if (p.disappearMode !== 'PERMANENT' && p.expiresAt) {
        if (new Date() > p.expiresAt) return false;
      }
      return true;
    });

    res.json({ success: true, posts: visible });

  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  LIKE / UNLIKE POST  (atomic, separate collection)
//  POST /api/posts/:id/like
// ─────────────────────────────────────────────────────────────

router.post('/:id/like', auth, likeLimiter, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (!post.allowLikes) return res.status(403).json({ success: false, message: 'Likes are disabled' });

    // Try to insert like — if duplicate key error, user already liked → unlike
    let liked = false;
    try {
      await PostLike.create({ userId: req.userId, postId: post._id });
      // ✅ Atomic increment
      await Post.findByIdAndUpdate(post._id, { $inc: { likeCount: 1 } });
      liked = true;
    } catch (err) {
      if (err.code === 11000) {
        // Already liked → remove
        await PostLike.deleteOne({ userId: req.userId, postId: post._id });
        await Post.findByIdAndUpdate(post._id, { $inc: { likeCount: -1 } });
        liked = false;
      } else {
        throw err;
      }
    }

    const updated = await Post.findById(post._id);

    // ── Socket: notify post author and anyone viewing the post ─
    const io = req.app.get('io');
    if (io) {
      io.to(`post:${post._id}`).emit('POST_LIKED', {
        postId:    post._id,
        likeCount: updated.likeCount,
        liked,
        byUserId: req.userId
      });
    }

    res.json({
      success:   true,
      liked,
      likeCount: updated.likeCount,
      message:   liked ? 'Post liked ❤️' : 'Post unliked'
    });

    // ── ✅ Activity: LIKE_POST — no push per spec ──────────────
    if (liked && post.userId.toString() !== req.userId.toString()) {
      const { createOrAggregateActivity } = require('../controllers/activityController');
      createOrAggregateActivity({
        userId:      post.userId,
        actorId:     req.userId,
        type:        'LIKE_POST',
        entityType:  'post',
        entityId:    post._id,
        entityImage: post.imageUrl,
      }).catch(e => console.error('[Activity] LIKE_POST:', e.message));
    }

  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  ADD COMMENT
//  POST /api/posts/:id/comment
// ─────────────────────────────────────────────────────────────

router.post('/:id/comment', auth, commentLimiter, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Comment text is required' });

    const post = await Post.findById(req.params.id);
    if (!post)            return res.status(404).json({ success: false, message: 'Post not found' });
    if (!post.allowComments) return res.status(403).json({ success: false, message: 'Comments are disabled' });

    // TODO: run text moderation here if needed
    // const { errors } = await moderateText(text);
    // if (errors.length) return res.status(422).json(...)

    const comment = await Comment.create({
      postId: post._id,
      userId: req.userId,
      text:   text.trim()
    });

    // ✅ Atomic commentCount increment on Post
    await Post.findByIdAndUpdate(post._id, { $inc: { commentCount: 1 } });

    await comment.populate('userId', 'firstName lastName profilePhoto');

    // ── Socket: broadcast to anyone viewing this post ──────────
    const io = req.app.get('io');
    if (io) {
      io.to(`post:${post._id}`).emit('NEW_COMMENT', { comment, postId: post._id });
    }

    res.json({ success: true, message: 'Comment added ✨', comment });

    // ── ✅ Activity: COMMENT_POST — no push per spec ───────────
    if (post.userId.toString() !== req.userId.toString()) {
      const { createOrAggregateActivity } = require('../controllers/activityController');
      const actorName = `${comment.userId.firstName} ${comment.userId.lastName || ''}`.trim();
      createOrAggregateActivity({
        userId:      post.userId,
        actorId:     req.userId,
        type:        'COMMENT_POST',
        entityType:  'post',
        entityId:    post._id,
        entityImage: post.imageUrl,
        message:     `${actorName} commented on your post`,
      }).catch(e => console.error('[Activity] COMMENT_POST:', e.message));
    }

  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET COMMENTS FOR A POST  (paginated)
//  GET /api/posts/:id/comments?cursor=<ISO>&limit=20
// ─────────────────────────────────────────────────────────────

router.get('/:id/comments', auth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor;
    const query  = { postId: req.params.id };

    if (cursor) query.createdAt = { $lt: new Date(cursor) };

    const comments = await Comment.find(query)
      .populate('userId', 'firstName lastName profilePhoto')
      .sort({ createdAt: -1 })
      .limit(limit + 1);

    const hasMore  = comments.length > limit;
    const result   = hasMore ? comments.slice(0, limit) : comments;

    // Bulk check which comments current user has liked
    const commentIds = result.map(c => c._id);
    const userCommentLikes = await CommentLike.find({
      userId:    req.userId,
      commentId: { $in: commentIds }
    }).select('commentId');
    const likedCommentSet = new Set(userCommentLikes.map(l => l.commentId.toString()));

    const enriched = result.map(c => ({
      ...c.toObject(),
      isLikedByMe: likedCommentSet.has(c._id.toString())
    }));

    const nextCursor = hasMore && result.length > 0
      ? result[result.length - 1].createdAt.toISOString()
      : null;

    res.json({ success: true, comments: enriched, nextCursor, hasMore });

  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  LIKE / UNLIKE COMMENT
//  POST /api/comments/:id/like
// ─────────────────────────────────────────────────────────────

router.post('/comments/:id/like', auth, likeLimiter, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });

    let liked = false;
    try {
      await CommentLike.create({ userId: req.userId, commentId: comment._id });
      await Comment.findByIdAndUpdate(comment._id, { $inc: { likeCount: 1 } });
      liked = true;
    } catch (err) {
      if (err.code === 11000) {
        await CommentLike.deleteOne({ userId: req.userId, commentId: comment._id });
        await Comment.findByIdAndUpdate(comment._id, { $inc: { likeCount: -1 } });
        liked = false;
      } else {
        throw err;
      }
    }

    const updated = await Comment.findById(comment._id);

    // ── Socket: notify viewers of the parent post ──────────────
    const io = req.app.get('io');
    if (io) {
      io.to(`post:${comment.postId}`).emit('COMMENT_LIKED', {
        commentId: comment._id,
        postId:    comment.postId,
        likeCount: updated.likeCount,
        liked,
        byUserId: req.userId
      });
    }

    res.json({ success: true, liked, likeCount: updated.likeCount });

  } catch (error) {
    console.error('Comment like error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POLL VOTE
//  POST /api/posts/:postId/vote
// ─────────────────────────────────────────────────────────────

router.post('/:postId/vote', auth, async (req, res) => {
  try {
    const { optionIndex } = req.body;
    if (optionIndex === undefined) return res.status(400).json({ success: false, message: 'optionIndex required' });

    const post = await Post.findById(req.params.postId);
    if (!post)         return res.status(404).json({ success: false, message: 'Post not found' });
    if (!post.hasPoll) return res.status(400).json({ success: false, message: 'Post has no poll' });
    if (optionIndex < 0 || optionIndex >= post.pollOptions.length) {
      return res.status(400).json({ success: false, message: 'Invalid option index' });
    }

    // Remove any previous vote by this user across all options
    post.pollOptions.forEach(opt => {
      const idx = opt.votes.indexOf(req.userId);
      if (idx > -1) opt.votes.splice(idx, 1);
    });
    post.pollOptions[optionIndex].votes.push(req.userId);
    await post.save();

    res.json({ success: true, message: 'Vote recorded ✨', post });

  } catch (error) {
    console.error('Poll vote error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE POST  (cascade: PostLike + Comment + CommentLike)
//  DELETE /api/posts/:id
// ─────────────────────────────────────────────────────────────

router.delete('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (post.userId.toString() !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // 1. Delete image from Cloudinary
    if (post.imagePublicId) {
      await cloudinary.uploader.destroy(post.imagePublicId);
    }

    // 2. Find all comment IDs for this post (for CommentLike cascade)
    const commentIds = await Comment.find({ postId: post._id }).select('_id');
    const commentIdList = commentIds.map(c => c._id);

    // 3. Cascade deletes in parallel
    await Promise.all([
      PostLike.deleteMany({ postId: post._id }),
      Comment.deleteMany({ postId: post._id }),
      CommentLike.deleteMany({ commentId: { $in: commentIdList } })
    ]);

    // 4. Delete the post itself
    await post.deleteOne();

    res.json({ success: true, message: 'Post deleted successfully' });

  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
