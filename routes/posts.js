// routes/posts.js - Post Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { enforceImageModeration } = require('../middleware/imageModerationMiddleware');
const Post = require('../models/Post');
const User = require('../models/User');
const { cloudinary, uploadBase64, deleteImage } = require('../config/cloudinary');

// @route   POST /api/posts
// @desc    Create a new post with image
// @access  Private
router.post('/', auth, enforceImageModeration, async (req, res) => {
  try {
    const {
      imageBase64,
      caption,
      location,
      disappearMode,
      disappearHours,
      vibeMode,
      allowComments,
      allowLikes,
      onlyFollowers,
      hasPoll,
      pollQuestion,
      pollOptions
    } = req.body;

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        message: 'Image is required'
      });
    }

    // ALWAYS log this once
    console.log('🧪 Base64 starts with:', imageBase64.substring(0, 30));

    const uploadResult = await uploadBase64(
      imageBase64.startsWith('data:')
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`,
      'humrah/posts'
    );

    // 🚨 THIS IS THE KEY CHECK
    if (!uploadResult || !uploadResult.url || !uploadResult.publicId) {
      console.error('❌ Cloudinary upload failed:', uploadResult);
      return res.status(500).json({
        success: false,
        message: 'Image upload failed'
      });
    }

    // Backfill publicId into the moderation audit log entry
    try {
      const user = await User.findById(req.userId);
      if (user?.imageModerationLog?.length) {
        const last = user.imageModerationLog[user.imageModerationLog.length - 1];
        if (last.action === 'ALLOWED' && !last.imagePublicId) {
          last.imagePublicId = uploadResult.publicId;
          await user.save();
        }
      }
    } catch (_) {
      // Non-critical — don't fail the upload if audit log update fails
    }

    // Parse poll options if provided
    let parsedPollOptions = [];
    if (hasPoll === 'true' && pollOptions) {
      const optionsArray = typeof pollOptions === 'string'
        ? pollOptions.split(',').filter(opt => opt.trim())
        : pollOptions;

      parsedPollOptions = optionsArray.map(opt => ({
        optionText: opt.trim(),
        votes: []
      }));
    }

    const post = new Post({
      userId: req.userId,
      imageUrl: uploadResult.url,
      imagePublicId: uploadResult.publicId,
      caption: caption || '',
      location: location || null,

      // Gen Z features
      disappearMode: disappearMode || 'PERMANENT',
      disappearHours: disappearHours ? parseInt(disappearHours) : null,
      vibeMode: vibeMode || 'NORMAL',
      allowComments: allowComments === 'true',
      allowLikes: allowLikes === 'true',
      onlyFollowers: onlyFollowers === 'true',
      hasPoll: hasPoll === 'true',
      pollQuestion: pollQuestion || null,
      pollOptions: parsedPollOptions
    });

    await post.save();

    res.status(201).json({
      success: true,
      message: 'Post created successfully ✨',
      post,
      moderation: {
        passed: true,
        scores: req.moderationResult?.scores || {}
      }
    });

  } catch (error) {
    console.error('🔥 Create post error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});


// @route   GET /api/posts/feed
// @desc    Get feed with all visible posts
// @access  Private
router.get('/feed', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    // Get all active posts
    const posts = await Post.find({ isActive: true })
      .populate('userId', 'firstName lastName profilePhoto')
      .populate('comments.userId', 'firstName lastName profilePhoto')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // Filter visible posts
    const visiblePosts = posts.filter(post => {
      if (post.disappearMode !== 'PERMANENT' && post.expiresAt) {
        if (new Date() > post.expiresAt) return false;
      }
      // TODO: Add follower check when User model has followers array
      // if (post.onlyFollowers && !isFollowing) return false;
      return true;
    });

    const total = await Post.countDocuments({ isActive: true });

    res.json({
      success: true,
      posts: visiblePosts,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalPosts: total
      }
    });

  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// @route   GET /api/posts/user/:userId
// @desc    Get posts by specific user
// @access  Private
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const posts = await Post.find({
      userId: req.params.userId,
      isActive: true
    })
      .populate('userId', 'firstName lastName profilePhoto')
      .sort({ createdAt: -1 });

    const visiblePosts = posts.filter(post => {
      if (post.disappearMode !== 'PERMANENT' && post.expiresAt) {
        if (new Date() > post.expiresAt) return false;
      }
      // TODO: Add follower check when User model has followers array
      // if (post.onlyFollowers && !isFollowing) return false;
      return true;
    });

    res.json({
      success: true,
      posts: visiblePosts
    });

  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// @route   POST /api/posts/:id/like
// @desc    Like/unlike a post
// @access  Private
router.post('/:id/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    if (!post.allowLikes) {
      return res.status(403).json({
        success: false,
        message: 'Likes are disabled for this post'
      });
    }

    const likeIndex = post.likes.indexOf(req.userId);

    if (likeIndex > -1) {
      post.likes.splice(likeIndex, 1);
    } else {
      post.likes.push(req.userId);
    }

    await post.save();
    await post.populate('userId', 'firstName lastName profilePhoto');

    res.json({
      success: true,
      message: likeIndex > -1 ? 'Post unliked' : 'Post liked ❤️',
      post
    });

  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// @route   POST /api/posts/:id/comment
// @desc    Add a comment to a post
// @access  Private
router.post('/:id/comment', auth, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Comment text is required'
      });
    }

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    if (!post.allowComments) {
      return res.status(403).json({
        success: false,
        message: 'Comments are disabled for this post'
      });
    }

    post.comments.push({
      userId: req.userId,
      text: text.trim()
    });

    await post.save();
    await post.populate('userId', 'firstName lastName profilePhoto');
    await post.populate('comments.userId', 'firstName lastName profilePhoto');

    res.json({
      success: true,
      message: 'Comment added',
      post
    });

  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// @route   POST /api/posts/:id/poll/vote
// @desc    Vote on a poll option
// @access  Private
router.post('/:id/poll/vote', auth, async (req, res) => {
  try {
    const { optionIndex } = req.body;

    if (optionIndex === undefined || optionIndex === null) {
      return res.status(400).json({
        success: false,
        message: 'Option index is required'
      });
    }

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    if (!post.hasPoll) {
      return res.status(400).json({
        success: false,
        message: 'This post does not have a poll'
      });
    }

    if (optionIndex < 0 || optionIndex >= post.pollOptions.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid option index'
      });
    }

    // Remove user's previous vote if exists
    post.pollOptions.forEach(option => {
      const voteIndex = option.votes.indexOf(req.userId);
      if (voteIndex > -1) {
        option.votes.splice(voteIndex, 1);
      }
    });

    // Add new vote
    post.pollOptions[optionIndex].votes.push(req.userId);

    await post.save();
    await post.populate('userId', 'firstName lastName profilePhoto');

    res.json({
      success: true,
      message: 'Vote recorded ✨',
      post
    });

  } catch (error) {
    console.error('Poll vote error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// @route   POST /api/posts/:id/repost
// @desc    Repost a post
// @access  Private
router.post('/:id/repost', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    if (!post.allowReposts) {
      return res.status(403).json({
        success: false,
        message: 'Reposts are disabled for this post'
      });
    }

    const repostIndex = post.reposts.findIndex(
      repost => repost.userId.toString() === req.userId
    );

    if (repostIndex > -1) {
      post.reposts.splice(repostIndex, 1);
      await post.save();

      return res.json({
        success: true,
        message: 'Repost removed',
        post
      });
    }

    post.reposts.push({ userId: req.userId });
    await post.save();
    await post.populate('userId', 'firstName lastName profilePhoto');

    res.json({
      success: true,
      message: 'Post reposted 🔄',
      post
    });

  } catch (error) {
    console.error('Repost error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// @route   DELETE /api/posts/:id
// @desc    Delete a post
// @access  Private
router.delete('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    if (post.userId.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this post'
      });
    }

    if (post.imagePublicId) {
      await cloudinary.uploader.destroy(post.imagePublicId);
    }

    await post.deleteOne();

    res.json({
      success: true,
      message: 'Post deleted successfully'
    });

  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
