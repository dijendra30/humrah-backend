// routes/moderation.js
// Admin endpoints for viewing and managing moderation flags
// Register in server.js:
//   app.use('/api/moderation', authenticate, adminOnly, require('./routes/moderation'));

const express = require('express');
const router  = express.Router();
const User    = require('../models/User');
const { runCleanup } = require('../utils/autoModerationCleanup');

// @route   GET /api/moderation/flagged
// @desc    List all flagged users with violation details
// @access  Admin only
router.get('/flagged', async (req, res) => {
  try {
    const { page = 1, limit = 20, onlyHardBlock = false } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { 'moderationFlags.isFlagged': true };
    if (onlyHardBlock === 'true') {
      query['moderationFlags.strikeCount'] = { $gt: 0 };
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('firstName lastName email status userType moderationFlags questionnaire createdAt')
        .sort({ 'moderationFlags.lastViolationAt': -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(query),
    ]);

    res.json({
      success: true,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      users: users.map(u => ({
        _id:            u._id,
        name:           `${u.firstName} ${u.lastName}`,
        email:          u.email,
        status:         u.status,
        userType:       u.userType,
        strikeCount:    u.moderationFlags?.strikeCount || 0,
        lastViolation:  u.moderationFlags?.lastViolationAt,
        autoSuspended:  !!u.moderationFlags?.autoSuspendedAt,
        reviewedByAdmin:u.moderationFlags?.reviewedByAdmin,
        recentViolations: (u.moderationFlags?.violations || []).slice(-5),
        currentBio:     u.questionnaire?.bio,
        currentGoodMeetupMeaning: u.questionnaire?.goodMeetupMeaning,
        currentVibeQuote: u.questionnaire?.vibeQuote,
      })),
    });
  } catch (err) {
    console.error('Get flagged users error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/moderation/users/:userId/review
// @desc    Admin marks a flagged user as reviewed (clears red flag)
// @access  Admin only
router.post('/users/:userId/review', async (req, res) => {
  try {
    const { action, note } = req.body;
    // action: 'clear' (false alarm) | 'warn' (keep flag, reset strikes) | 'suspend' | 'ban'

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.moderationFlags) user.moderationFlags = {};

    user.moderationFlags.reviewedByAdmin = true;
    user.moderationFlags.adminReviewNote = note || null;

    if (action === 'clear') {
      user.moderationFlags.isFlagged  = false;
      user.moderationFlags.strikeCount = 0;
      if (user.status === 'SUSPENDED' && user.moderationFlags.autoSuspendedAt) {
        user.status = 'ACTIVE';
        if (user.suspensionInfo) user.suspensionInfo.isSuspended = false;
      }
    } else if (action === 'warn') {
      user.moderationFlags.strikeCount = 1; // reset to 1 — one more and they're gone
    } else if (action === 'suspend') {
      user.status = 'SUSPENDED';
      user.suspensionInfo = {
        isSuspended: true,
        suspensionReason: note || 'Suspended by admin after moderation review',
        suspendedAt: new Date(),
        suspendedUntil: null,
      };
    } else if (action === 'ban') {
      user.status = 'BANNED';
      user.banInfo = {
        isBanned: true,
        banReason: note || 'Banned by admin after moderation review',
        bannedAt: new Date(),
        isPermanent: true,
      };
    }

    user.markModified('moderationFlags');
    await user.save();

    res.json({ success: true, message: `User ${action} action applied`, userId: user._id, status: user.status });

  } catch (err) {
    console.error('Review flagged user error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/moderation/run-cleanup
// @desc    Admin: manually trigger a full moderation scan
// @access  Admin only
router.post('/run-cleanup', async (req, res) => {
  try {
    res.json({ success: true, message: 'Cleanup started — check server logs for progress' });
    // Run async after response (don't block)
    runCleanup('MANUAL_ADMIN_TRIGGER').catch(e =>
      console.error('[MODERATION] Manual cleanup error:', e)
    );
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/moderation/stats
// @desc    Admin: moderation system health stats
// @access  Admin only
router.get('/stats', async (req, res) => {
  try {
    const [flagged, autoSuspended, totalViolations] = await Promise.all([
      User.countDocuments({ 'moderationFlags.isFlagged': true }),
      User.countDocuments({ 'moderationFlags.autoSuspendedAt': { $ne: null } }),
      User.aggregate([
        { $match: { 'moderationFlags.violations': { $exists: true, $ne: [] } } },
        { $project: { count: { $size: '$moderationFlags.violations' } } },
        { $group: { _id: null, total: { $sum: '$count' } } },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        flaggedUsers:        flagged,
        autoSuspendedUsers:  autoSuspended,
        totalViolationsLogged: totalViolations[0]?.total || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
