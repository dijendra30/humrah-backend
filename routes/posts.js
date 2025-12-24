// routes/posts.js - Post Routes
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Post = require('../models/Post');
const { uploadBase64, deleteImage } = require('../config/cloudinary');

// @route   POST /api/posts
// @desc    Create a new post with image
// @access  Private
router.post('/', auth, async (req, res) => {
  try {
    const { imageBase64, caption, location, musicTrack } = req.body;

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

    const post = new Post({
      userId: req.userId,
      imageUrl: uploadResult.url,
      imagePublicId: uploadResult.publicId,
      caption: caption || '',
      location: location || null,
      musicTrack: musicTrack || null
    });

    await post.save();

    res.status(201).json({
      success: true,
      message: 'Post created successfully',
      post
    });

  } catch (error) {
    console.error('🔥 Create post error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});


// @route   GET /api/posts/user/:userId
// @desc    Get posts by specific user
// @access  Private
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const posts = await Post.find({ userId: req.params.userId })
      .populate('userId', 'firstName lastName profilePhoto')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      posts
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
      message: likeIndex > -1 ? 'Post unliked' : 'Post liked',
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
