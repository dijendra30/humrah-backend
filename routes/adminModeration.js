const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Post = require('../models/Post');
const PostReport = require('../models/PostReport');
const AuditLog = require('../models/AuditLog');
const { auditLog } = require('../middleware/auth');
const { createOrAggregateActivity } = require('../controllers/activityController');
const { getMessaging } = require('firebase-admin/messaging');
const User = require('../models/User');

// GET /api/admin/moderation/posts
router.get('/posts', async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    
    let query = {};
    
    if (status === 'ACTIVE') query.moderationStatus = 'ACTIVE';
    if (status === 'HELD') query.moderationStatus = 'HELD';
    if (status === 'REMOVED') query.moderationStatus = 'REMOVED';
    if (status === 'REPORTED') query.reportCount = { $gt: 0 };
    
    // Default legacy support (null = ACTIVE) if ACTIVE is requested
    if (status === 'ACTIVE') {
      query = {
        $or: [
          { moderationStatus: 'ACTIVE' },
          { moderationStatus: { $exists: false } }
        ]
      };
    }

    if (search) {
      // Find users matching search term to get their ids to search by userId, or just search caption
      // For simplicity, search caption
      query.caption = { $regex: search, $options: 'i' };
    }

    const posts = await Post.find(query)
      .populate('userId', 'firstName lastName email profilePhoto status')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));

    const total = await Post.countDocuments(query);

    res.json({
      success: true,
      posts,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        total
      }
    });

  } catch (error) {
    console.error('Get admin posts error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/moderation/posts/:id
router.get('/posts/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('userId', 'firstName lastName email profilePhoto status');

    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const reports = await PostReport.find({ postId: post._id })
      .populate('reportedBy', 'firstName lastName email profilePhoto')
      .sort({ createdAt: -1 });

    const auditHistory = await AuditLog.find({ targetId: post._id, targetType: 'POST' })
      .populate('actorId', 'firstName lastName email role')
      .sort({ timestamp: -1 });

    res.json({
      success: true,
      post,
      reports,
      history: auditHistory
    });

  } catch (error) {
    console.error('Get admin post detail error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper for FCM and Activity
async function notifyModerationEvent(userId, actorId, type, message, postId) {
  try {
    // 1. Community Activity Record (Mandatory)
    await createOrAggregateActivity({
      userId: userId,
      actorId: actorId, // Admin who did it
      type: type, // POST_HELD, POST_REMOVED, POST_RESTORED
      entityType: 'post',
      entityId: postId,
      message: message
    });
    
    // 2. FCM Notification (Best effort)
    const owner = await User.findById(userId).select('fcmTokens');
    if (owner && owner.fcmTokens && owner.fcmTokens.length > 0) {
      await getMessaging().sendEachForMulticast({
        notification: { title: '🛡️ Post Moderation', body: message },
        data: { type: type, postId: postId.toString() },
        tokens: owner.fcmTokens
      });
    }
  } catch (error) {
    console.error(`Moderation notification error for ${type}:`, error.message);
    // Don't throw, let moderation succeed even if FCM/Activity fails
  }
}

// PATCH /api/admin/moderation/posts/:id/hold
router.patch('/posts/:id/hold', auditLog('HOLD_POST', 'POST'), async (req, res) => {
  try {
    const { userMessage, internalNote, reasonCode } = req.body;
    
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    if (post.moderationStatus === 'HELD') {
       return res.status(400).json({ success: false, message: 'Post is already held' });
    }

    const previousState = post.moderationStatus;
    
    post.moderationStatus = 'HELD';
    await post.save();

    // Log the audit with internal note and user message
    const adminUser = await User.findById(req.userId).select('email role');
    await AuditLog.logAction({
      actorId: req.userId,
      actorRole: adminUser ? adminUser.role : 'SAFETY_ADMIN',
      actorEmail: adminUser ? adminUser.email : 'unknown',
      action: 'HOLD_POST',
      targetType: 'POST',
      targetId: post._id,
      relatedPostId: post._id,
      reason: reasonCode || 'Admin Hold',
      details: {
        userMessage,
        internalNote
      },
      previousState: { moderationStatus: previousState },
      newState: { moderationStatus: 'HELD' }
    });

    const msg = userMessage || "Your post has been temporarily held for review by our moderation team.";
    await notifyModerationEvent(post.userId, req.userId, 'POST_HELD', msg, post._id);

    res.json({ success: true, message: 'Post held successfully', post });
  } catch (error) {
    console.error('Hold post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/moderation/posts/:id/restore
router.patch('/posts/:id/restore', auditLog('RESTORE_POST', 'POST'), async (req, res) => {
  try {
    const { userMessage, internalNote, reasonCode } = req.body;
    
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    if (post.moderationStatus === 'ACTIVE' || !post.moderationStatus) {
       return res.status(400).json({ success: false, message: 'Post is already active' });
    }

    const previousState = post.moderationStatus;
    
    post.moderationStatus = 'ACTIVE';
    await post.save();

    const adminUser = await User.findById(req.userId).select('email role');
    await AuditLog.logAction({
      actorId: req.userId,
      actorRole: adminUser ? adminUser.role : 'SAFETY_ADMIN',
      actorEmail: adminUser ? adminUser.email : 'unknown',
      action: 'RESTORE_POST',
      targetType: 'POST',
      targetId: post._id,
      relatedPostId: post._id,
      reason: reasonCode || 'Admin Restore',
      details: {
        userMessage,
        internalNote
      },
      previousState: { moderationStatus: previousState },
      newState: { moderationStatus: 'ACTIVE' }
    });

    const msg = userMessage || "Your post has been reviewed and restored to the community feed.";
    await notifyModerationEvent(post.userId, req.userId, 'POST_RESTORED', msg, post._id);

    res.json({ success: true, message: 'Post restored successfully', post });
  } catch (error) {
    console.error('Restore post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/moderation/posts/:id/remove
router.patch('/posts/:id/remove', auditLog('REMOVE_POST', 'POST'), async (req, res) => {
  try {
    const { userMessage, internalNote, reasonCode } = req.body;
    
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    if (post.moderationStatus === 'REMOVED') {
       return res.status(400).json({ success: false, message: 'Post is already removed' });
    }

    const previousState = post.moderationStatus;
    
    post.moderationStatus = 'REMOVED';
    await post.save();

    const adminUser = await User.findById(req.userId).select('email role');
    await AuditLog.logAction({
      actorId: req.userId,
      actorRole: adminUser ? adminUser.role : 'SAFETY_ADMIN',
      actorEmail: adminUser ? adminUser.email : 'unknown',
      action: 'REMOVE_POST',
      targetType: 'POST',
      targetId: post._id,
      relatedPostId: post._id,
      reason: reasonCode || 'Community Guidelines Violation',
      details: {
        userMessage,
        internalNote
      },
      previousState: { moderationStatus: previousState },
      newState: { moderationStatus: 'REMOVED' }
    });

    const msg = userMessage || "Your post has been removed for violating our community guidelines.";
    await notifyModerationEvent(post.userId, req.userId, 'POST_REMOVED', msg, post._id);

    res.json({ success: true, message: 'Post removed successfully', post });
  } catch (error) {
    console.error('Remove post error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
