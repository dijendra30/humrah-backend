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
const PostReport = require('../models/PostReport');

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
    const cursor     = req.query.cursor || req.query.before; // support both param names

    const query = { isActive: true };

    // Cursor filter: only posts OLDER than the cursor timestamp
    if (cursor) {
      query.createdAt = { $lt: new Date(cursor) };
    }

    // Fetch current user to get blocked/muted/hidden/notInterested lists
    const currentUser = await User.findById(req.userId).select(
      'blockedUsers mutedUsers hiddenPosts notInterestedUsers'
    );

    const blockedIds    = (currentUser?.blockedUsers        || []).map(id => id.toString());
    const mutedIds      = (currentUser?.mutedUsers          || []).map(id => id.toString());
    const hiddenPostIds = (currentUser?.hiddenPosts         || []).map(id => id.toString());
    const notInterestedMap = {};
    (currentUser?.notInterestedUsers || []).forEach(entry => {
      notInterestedMap[entry.userId.toString()] = entry.score;
    });

    // Exclude posts from blocked + muted users, and hidden posts
    if (blockedIds.length || mutedIds.length) {
      query.userId = { $nin: [...blockedIds, ...mutedIds] };
    }
    if (hiddenPostIds.length) {
      query._id = { $nin: hiddenPostIds };
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
      // Not-interested score filter: score >= 3 → ~30% chance to show
      const authorId = p.userId?._id?.toString();
      if (authorId && notInterestedMap[authorId]) {
        const score = notInterestedMap[authorId];
        if (score >= 3) {
          // Only show 1 in every (score) posts from this user
          return Math.random() < (1 / score);
        }
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
//  REPORT POST
//  POST /api/posts/:id/report
// ─────────────────────────────────────────────────────────────

router.post('/:id/report', auth, async (req, res) => {
  try {
    const { reason } = req.body;
    const validReasons = ['Spam', 'Harassment', 'Fake Profile', 'Sexual Content', 'Scam', 'Violence', 'Other'];
    if (!reason || !validReasons.includes(reason)) {
      return res.status(400).json({ success: false, message: 'Valid reason is required' });
    }

    const post = await Post.findById(req.params.id).select('userId imageUrl');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (post.userId.toString() === req.userId) {
      return res.status(400).json({ success: false, message: 'Cannot report your own post' });
    }

    // Save to PostReport (unique per reporter+post)
    try {
      await PostReport.create({
        reportedBy:   req.userId,
        reportedUser: post.userId,
        postId:       post._id,
        reason,
        status:       'manual_review'
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ success: false, message: 'You have already reported this post' });
      }
      throw err;
    }

    // Hide this post from the reporter's feed
    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { hiddenPosts: post._id }
    });

    // ── STRIKE SYSTEM (unique reporters only) ──────────────────────────────
    const uniqueReportCount = await PostReport.countDocuments({
      reportedUser: post.userId,
      reportedBy:   { $ne: post.userId } // safety: exclude self
    });

    const reportedUser = await User.findById(post.userId);
    if (reportedUser) {
      const io = req.app.get('io');

      if (uniqueReportCount === 4) {
        // ⚠️ Warning
        if (io) {
          io.to(post.userId.toString()).emit('MODERATION_WARNING', {
            type:    'WARNING',
            message: '⚠️ Your content has received multiple reports. Please review our community guidelines to keep Humrah safe for everyone.'
          });
        }
      } else if (uniqueReportCount === 6) {
        // ⚠️ Warning + 3-day temp ban
        const suspendedUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
        reportedUser.suspensionInfo = {
          isSuspended:      true,
          suspensionReason: 'Multiple community reports',
          suspendedAt:      new Date(),
          suspendedUntil,
          autoLiftAt:       suspendedUntil,
          suspendedBy:      'system'
        };
        reportedUser.status = 'SUSPENDED';
        await reportedUser.save();

        if (io) {
          io.to(post.userId.toString()).emit('MODERATION_WARNING', {
            type:    'TEMP_BAN',
            message: '⚠️ Your account has been temporarily suspended for 3 days due to multiple violations. This decision can be reviewed by our admin team.'
          });
        }
      } else if (uniqueReportCount > 6) {
        // 🚫 Permanent ban (admin can audit)
        reportedUser.suspensionInfo = {
          isSuspended:      true,
          suspensionReason: 'Repeated community violations',
          suspendedAt:      new Date(),
          suspendedBy:      'system'
        };
        reportedUser.status = 'BANNED';
        await reportedUser.save();

        if (io) {
          io.to(post.userId.toString()).emit('MODERATION_WARNING', {
            type:    'PERM_BAN',
            message: '🚫 Your account has been permanently suspended due to repeated violations. If you believe this is a mistake, please contact our support team.'
          });
        }
      }
    }

    res.json({ success: true, message: 'Post reported. Thank you for keeping Humrah safe. 🛡️' });
  } catch (error) {
    console.error('Report post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  EDIT POST  (owner only — no image change)
//  PATCH /api/posts/:id
// ─────────────────────────────────────────────────────────────

router.patch('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (post.userId.toString() !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const {
      caption, location, vibeMode,
      allowComments, allowLikes, onlyFollowers
    } = req.body;

    if (caption      !== undefined) post.caption      = caption;
    if (location     !== undefined) post.location     = location || null;
    if (vibeMode     !== undefined) post.vibeMode     = vibeMode;
    if (allowComments !== undefined) post.allowComments = allowComments === 'true' || allowComments === true;
    if (allowLikes   !== undefined) post.allowLikes   = allowLikes   === 'true' || allowLikes   === true;
    if (onlyFollowers !== undefined) post.onlyFollowers = onlyFollowers === 'true' || onlyFollowers === true;

    await post.save();
    await post.populate('userId', 'firstName lastName profilePhoto');

    // Socket: notify anyone viewing this post
    const io = req.app.get('io');
    if (io) {
      io.to(`post:${post._id}`).emit('POST_UPDATED', { post });
    }

    res.json({ success: true, message: 'Post updated! ✨', post });
  } catch (error) {
    console.error('Edit post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  TOGGLE COMMENTS ON/OFF  (owner only)
//  PATCH /api/posts/:id/toggle-comments
// ─────────────────────────────────────────────────────────────

router.patch('/:id/toggle-comments', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (post.userId.toString() !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    post.allowComments = !post.allowComments;
    await post.save();

    res.json({
      success:       true,
      allowComments: post.allowComments,
      message:       post.allowComments ? 'Comments enabled' : 'Comments disabled'
    });
  } catch (error) {
    console.error('Toggle comments error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  SAVE / BOOKMARK POST
//  POST /api/posts/:id/save
// ─────────────────────────────────────────────────────────────

router.post('/:id/save', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const savedPosts = user.savedPosts || [];
    const alreadySaved = savedPosts.some(id => id.toString() === post._id.toString());

    if (alreadySaved) {
      user.savedPosts = savedPosts.filter(id => id.toString() !== post._id.toString());
    } else {
      user.savedPosts = [...savedPosts, post._id];
    }

    await user.save();
    res.json({ success: true, saved: !alreadySaved });
  } catch (error) {
    console.error('Save post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET SAVED POST IDS
//  GET /api/posts/saved
// ─────────────────────────────────────────────────────────────

router.get('/saved', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('savedPosts');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const posts = await Post.find({ _id: { $in: user.savedPosts || [] }, isActive: true })
      .populate('userId', 'firstName lastName profilePhoto')
      .sort({ createdAt: -1 });

    res.json({ success: true, posts });
  } catch (error) {
    console.error('Get saved posts error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  BLOCK USER (from post context)
//  POST /api/posts/:id/block-author
// ─────────────────────────────────────────────────────────────

router.post('/:id/block-author', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('userId');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const targetUserId = post.userId.toString();
    if (targetUserId === req.userId) {
      return res.status(400).json({ success: false, message: 'Cannot block yourself' });
    }

    // Add to blocker's blockedUsers list
    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { blockedUsers: targetUserId }
    });
    // Remove blocked user's posts from feed automatically via blockedUsers filter

    res.json({ success: true, message: 'User blocked', blockedUserId: targetUserId });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  MUTE USER (from post context)
//  POST /api/posts/:id/mute-author
// ─────────────────────────────────────────────────────────────

router.post('/:id/mute-author', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('userId');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const targetUserId = post.userId.toString();
    if (targetUserId === req.userId) {
      return res.status(400).json({ success: false, message: 'Cannot mute yourself' });
    }

    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { mutedUsers: targetUserId }
    });

    res.json({ success: true, message: 'User muted', mutedUserId: targetUserId });
  } catch (error) {
    console.error('Mute user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  HIDE POST (from feed — per-user preference)
//  POST /api/posts/:id/hide
// ─────────────────────────────────────────────────────────────

router.post('/:id/hide', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('_id');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { hiddenPosts: post._id }
    });

    res.json({ success: true, message: 'Post hidden from your feed' });
  } catch (error) {
    console.error('Hide post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  NOT INTERESTED
//  POST /api/posts/:id/not-interested
// ─────────────────────────────────────────────────────────────

router.post('/:id/not-interested', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('userId');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const targetUserId = post.userId.toString();

    // Hide this specific post
    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { hiddenPosts: post._id }
    });

    // Increment not-interested score for this author
    const user = await User.findById(req.userId).select('notInterestedUsers');
    const existing = user.notInterestedUsers.find(
      e => e.userId.toString() === targetUserId
    );

    if (existing) {
      await User.findOneAndUpdate(
        { _id: req.userId, 'notInterestedUsers.userId': targetUserId },
        { $inc: { 'notInterestedUsers.$.score': 1 } }
      );
    } else {
      await User.findByIdAndUpdate(req.userId, {
        $push: { notInterestedUsers: { userId: targetUserId, score: 1 } }
      });
    }

    res.json({ success: true, message: 'Got it — you will see less like this' });
  } catch (error) {
    console.error('Not interested error:', error);
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

// ─────────────────────────────────────────────────────────────
//  UNHIDE POST
//  DELETE /api/posts/:postId/hide
// ─────────────────────────────────────────────────────────────

router.delete('/:postId/hide', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      $pull: { hiddenPosts: req.params.postId }
    });
    res.json({ success: true, message: 'Post unhidden' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
