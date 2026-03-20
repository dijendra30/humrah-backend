// controllers/moderation_controller.js
const User       = require('../models/User');
const UserReport = require('../models/UserReport');
const { sendWarningEmail }    = require('../config/email');
const { sendWarningActivity } = require('../utils/sendWarningActivity');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/report-user
// Body: { reportedUserId, reason, description }
// ─────────────────────────────────────────────────────────────────────────────
exports.reportUser = async (req, res) => {
  try {
    const reporterId = req.userId;                             // set by authenticate
    const { reportedUserId, reason, description } = req.body;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!reportedUserId || !reason) {
      return res.status(400).json({
        success: false,
        message: 'reportedUserId and reason are required'
      });
    }

    if (reporterId.toString() === reportedUserId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot report yourself'
      });
    }

    // ── Valid reasons guard ───────────────────────────────────────────────────
    const validReasons = [
      'Fake profile',
      'Harassment or inappropriate behaviour',
      'Spam or promotion',
      'Unsafe behaviour',
      'Other'
    ];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reason provided'
      });
    }

    // ── Check reported user exists ────────────────────────────────────────────
    const reportedUser = await User.findById(reportedUserId).select('firstName email');
    if (!reportedUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // ── Prevent duplicate — unique index also enforces this at DB level ───────
    const existing = await UserReport.findOne({ reporterId, reportedUserId });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You already reported this user'
      });
    }

    // ── Save report ───────────────────────────────────────────────────────────
    await UserReport.create({
      reporterId,
      reportedUserId,
      reason,
      description: description?.trim() || ''
    });

    // ── Threshold checks ──────────────────────────────────────────────────────
    const totalReports = await UserReport.countDocuments({ reportedUserId });

    // ── §5 Threshold: 3 reports → warning email + activity feed + push ──────
    if (totalReports === 3) {
      try {
        await sendWarningEmail(reportedUser.email, reportedUser.firstName);
        console.log(`⚠️  Warning email sent to ${reportedUser.email}`);
      } catch (emailErr) {
        console.error('❌ Warning email failed:', emailErr.message);
      }
      // ✅ Activity feed entry + push notification (spec §6)
      sendWarningActivity({ userId: reportedUserId }).catch(e =>
        console.error('[ModerationCtrl] WARNING activity failed:', e.message)
      );
    }

    // ── §5 Threshold: 5 reports → temporary 7-day account restriction ────────
    if (totalReports === 5) {
      const suspendedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      await User.findByIdAndUpdate(reportedUserId, {
        $set: {
          status: 'SUSPENDED',
          'suspensionInfo.isSuspended':     true,
          'suspensionInfo.suspensionReason': 'Received 5 community reports',
          'suspensionInfo.suspendedAt':      new Date(),
          'suspensionInfo.suspendedUntil':   suspendedUntil,
          'suspensionInfo.suspendedBy':      'SYSTEM',
          'suspensionInfo.autoLiftAt':       suspendedUntil,
          'moderationFlags.isFlagged':       true,
        }
      });

      console.log(`🚫 User ${reportedUserId} suspended for 7 days after 5 reports. Lifts: ${suspendedUntil}`);
    }

    // ── §5 Threshold: >5 reports → keep flagged, extend suspension ───────────
    if (totalReports > 5) {
      await User.findByIdAndUpdate(reportedUserId, {
        $set: { 'moderationFlags.isFlagged': true }
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Report submitted successfully',
      totalReports
    });

  } catch (error) {
    // Mongoose duplicate key (race condition fallback)
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
// POST /api/block-user
// Body: { blockedUserId }
// ─────────────────────────────────────────────────────────────────────────────
exports.blockUser = async (req, res) => {
  try {
    const currentUserId     = req.userId;
    const { blockedUserId } = req.body;

    if (!blockedUserId) {
      return res.status(400).json({ success: false, message: 'blockedUserId is required' });
    }

    if (currentUserId.toString() === blockedUserId.toString()) {
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
// DELETE /api/unblock-user
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
