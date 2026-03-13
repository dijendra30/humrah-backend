// controllers/moderation_controller.js
const User       = require('../models/User');
const UserReport = require('../models/UserReport');
const { sendWarningEmail } = require('../utils/email');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/moderation/report-user
// Body: { reportedUserId, reason, description }
// ─────────────────────────────────────────────────────────────────────────────
exports.reportUser = async (req, res) => {
  try {
    const reporterId           = req.userId;
    const { reportedUserId, reason, description } = req.body;

    // ── Basic validation ────────────────────────────────────────────────────
    if (!reportedUserId || !reason) {
      return res.status(400).json({
        success: false,
        message: 'reportedUserId and reason are required'
      });
    }

    if (reporterId.toString() === reportedUserId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot report yourself'
      });
    }

    // ── Check reported user exists ──────────────────────────────────────────
    const reportedUser = await User.findById(reportedUserId).select('firstName email');
    if (!reportedUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // ── Prevent duplicate report (unique index handles this too) ────────────
    const existing = await UserReport.findOne({ reporterId, reportedUserId });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You already reported this user'
      });
    }

    // ── Save report ─────────────────────────────────────────────────────────
    await UserReport.create({
      reporterId,
      reportedUserId,
      reason,
      description: description?.trim() || ''
    });

    // ── Count total reports against this user ───────────────────────────────
    const totalReports = await UserReport.countDocuments({ reportedUserId });

    // ── Threshold: 3 reports → send warning email ───────────────────────────
    if (totalReports === 3) {
      try {
        await sendWarningEmail(reportedUser.email, reportedUser.firstName);
        console.log(`⚠️  Warning email sent to ${reportedUser.email} (3 reports reached)`);
      } catch (emailErr) {
        // Don't fail the request if email errors
        console.error('❌ Warning email failed:', emailErr.message);
      }
    }

    // ── Threshold: 5 reports → flag for admin review (future: auto-suspend) ─
    if (totalReports >= 5) {
      await User.findByIdAndUpdate(reportedUserId, {
        $set: { 'moderationFlags.isFlagged': true }
      });
      console.log(`🚩 User ${reportedUserId} flagged after ${totalReports} reports`);
    }

    return res.status(201).json({
      success: true,
      message: 'Report submitted successfully',
      totalReports
    });

  } catch (error) {
    // Mongoose duplicate key error (race condition fallback)
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'You already reported this user'
      });
    }
    console.error('reportUser error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/moderation/block-user
// Body: { blockedUserId }
// ─────────────────────────────────────────────────────────────────────────────
exports.blockUser = async (req, res) => {
  try {
    const currentUserId       = req.userId;
    const { blockedUserId }   = req.body;

    if (!blockedUserId) {
      return res.status(400).json({ success: false, message: 'blockedUserId is required' });
    }

    if (currentUserId.toString() === blockedUserId) {
      return res.status(400).json({ success: false, message: 'You cannot block yourself' });
    }

    const targetUser = await User.findById(blockedUserId).select('_id');
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // $addToSet is idempotent — safe to call multiple times
    await User.findByIdAndUpdate(currentUserId, {
      $addToSet: { blockedUsers: blockedUserId }
    });

    return res.status(200).json({
      success: true,
      message: 'User blocked successfully'
    });

  } catch (error) {
    console.error('blockUser error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/moderation/unblock-user
// Body: { blockedUserId }
// ─────────────────────────────────────────────────────────────────────────────
exports.unblockUser = async (req, res) => {
  try {
    const currentUserId     = req.userId;
    const { blockedUserId } = req.body;

    if (!blockedUserId) {
      return res.status(400).json({ success: false, message: 'blockedUserId is required' });
    }

    await User.findByIdAndUpdate(currentUserId, {
      $pull: { blockedUsers: blockedUserId }
    });

    return res.status(200).json({
      success: true,
      message: 'User unblocked successfully'
    });

  } catch (error) {
    console.error('unblockUser error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
