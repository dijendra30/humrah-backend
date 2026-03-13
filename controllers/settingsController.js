// controllers/settingsController.js
// Handles all Account Settings operations for Humrah

const bcrypt    = require('bcryptjs');
const User      = require('../models/User');
const BugReport = require('../models/BugReport');
const { sendOTPEmail } = require('../config/email');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Generate a 6-digit numeric OTP */
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/** Simple email format check */
const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// ══════════════════════════════════════════════════════════════════════════════
// CHANGE EMAIL — STEP 1: Send OTP to the NEW email address
// POST /api/settings/email/send-otp
// Body: { newEmail }
// ══════════════════════════════════════════════════════════════════════════════
exports.sendEmailChangeOTP = async (req, res) => {
  try {
    const { newEmail } = req.body;

    // 1. Validate format
    if (!newEmail || !isValidEmail(newEmail)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
    }

    // 2. Cannot be same as current email
    if (newEmail.toLowerCase() === req.user.email.toLowerCase()) {
      return res.status(400).json({ success: false, message: 'New email must be different from your current email.' });
    }

    // 3. Check no other account uses this email
    const existing = await User.findOne({ email: newEmail.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'This email address is already in use by another account.' });
    }

    // 4. Generate OTP and persist it temporarily on the user document
    const otp     = generateOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await User.findByIdAndUpdate(req.userId, {
      pendingEmail:           newEmail.toLowerCase(),
      pendingEmailOTP:        otp,
      pendingEmailOTPExpires: expires
    });

    // 5. Send OTP to the NEW email address
    await sendOTPEmail(newEmail, otp, req.user.firstName);

    res.json({
      success: true,
      message: `Verification code sent to ${newEmail}. It expires in 10 minutes.`
    });

  } catch (err) {
    console.error('sendEmailChangeOTP error:', err);
    res.status(500).json({ success: false, message: 'Failed to send verification code. Please try again.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// CHANGE EMAIL — STEP 2: Verify OTP and apply the new email
// PUT /api/settings/email
// Body: { newEmail, otp }
// ══════════════════════════════════════════════════════════════════════════════
exports.updateEmail = async (req, res) => {
  try {
    const { newEmail, otp } = req.body;

    if (!newEmail || !otp) {
      return res.status(400).json({ success: false, message: 'New email and OTP are required.' });
    }

    // Fetch the user WITH the pending OTP fields (normally excluded)
    const user = await User.findById(req.userId).select(
      '+pendingEmail +pendingEmailOTP +pendingEmailOTPExpires'
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Validate the pending email matches what was submitted
    if (
      !user.pendingEmail ||
      user.pendingEmail.toLowerCase() !== newEmail.toLowerCase()
    ) {
      return res.status(400).json({ success: false, message: 'No pending email change for this address. Please request a new code.' });
    }

    // Check OTP expiry
    if (!user.pendingEmailOTPExpires || new Date() > user.pendingEmailOTPExpires) {
      return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new one.' });
    }

    // Check OTP value
    if (user.pendingEmailOTP !== otp) {
      return res.status(400).json({ success: false, message: 'Incorrect verification code. Please try again.' });
    }

    // Double-check the new email is still not taken (race condition guard)
    const conflict = await User.findOne({
      email: newEmail.toLowerCase(),
      _id:   { $ne: req.userId }
    });
    if (conflict) {
      return res.status(400).json({ success: false, message: 'This email address has been taken. Please choose another.' });
    }

    // Apply the change and clear OTP fields
    user.email                   = newEmail.toLowerCase();
    user.pendingEmail            = undefined;
    user.pendingEmailOTP         = undefined;
    user.pendingEmailOTPExpires  = undefined;
    await user.save();

    res.json({ success: true, message: 'Email address updated successfully.' });

  } catch (err) {
    console.error('updateEmail error:', err);
    res.status(500).json({ success: false, message: 'Failed to update email. Please try again.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// CHANGE PASSWORD
// PUT /api/settings/password
// Body: { currentPassword, newPassword }
// ══════════════════════════════════════════════════════════════════════════════
exports.updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }

    // Fetch user WITH password hash
    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    // Assign plain password — the User model's pre('save') hook hashes it automatically.
    // Do NOT manually bcrypt.hash here; doing so would cause double-hashing.
    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: 'Password updated successfully.' });

  } catch (err) {
    console.error('updatePassword error:', err);
    res.status(500).json({ success: false, message: 'Failed to update password. Please try again.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION SETTINGS
// PUT /api/settings/notifications
// Body: { activityRequests, gamingAlerts, communityActivity, appUpdates }
// ══════════════════════════════════════════════════════════════════════════════
exports.updateNotifications = async (req, res) => {
  try {
    const { activityRequests, gamingAlerts, communityActivity, appUpdates } = req.body;

    // Build an explicit update so only valid fields are set
    const update = {};
    if (typeof activityRequests  === 'boolean') update['notifications.activityRequests']  = activityRequests;
    if (typeof gamingAlerts      === 'boolean') update['notifications.gamingAlerts']      = gamingAlerts;
    if (typeof communityActivity === 'boolean') update['notifications.communityActivity'] = communityActivity;
    if (typeof appUpdates        === 'boolean') update['notifications.appUpdates']        = appUpdates;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid notification fields provided.' });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: update },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Notification preferences updated.',
      notifications: user.notifications
    });

  } catch (err) {
    console.error('updateNotifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to update notifications.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// GET BLOCKED USERS
// GET /api/settings/blocked-users
// ══════════════════════════════════════════════════════════════════════════════
exports.getBlockedUsers = async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .populate('blockedUsers', 'firstName lastName profilePhoto');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const blocked = (user.blockedUsers || []).map(u => ({
      id:           u._id.toString(),
      name:         `${u.firstName} ${u.lastName}`.trim(),
      profilePhoto: u.profilePhoto || null
    }));

    res.json({ success: true, blockedUsers: blocked });

  } catch (err) {
    console.error('getBlockedUsers error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch blocked users.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// BLOCK A USER
// POST /api/settings/block
// Body: { targetUserId }
// ══════════════════════════════════════════════════════════════════════════════
exports.blockUser = async (req, res) => {
  try {
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId is required.' });
    }

    if (targetUserId === req.userId.toString()) {
      return res.status(400).json({ success: false, message: 'You cannot block yourself.' });
    }

    const target = await User.findById(targetUserId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Add to blockedUsers if not already there
    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { blockedUsers: targetUserId }
    });

    res.json({ success: true, message: 'User blocked successfully.' });

  } catch (err) {
    console.error('blockUser error:', err);
    res.status(500).json({ success: false, message: 'Failed to block user.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// UNBLOCK A USER
// DELETE /api/settings/unblock/:userId
// ══════════════════════════════════════════════════════════════════════════════
exports.unblockUser = async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;

    await User.findByIdAndUpdate(req.userId, {
      $pull: { blockedUsers: targetUserId }
    });

    res.json({ success: true, message: 'User unblocked successfully.' });

  } catch (err) {
    console.error('unblockUser error:', err);
    res.status(500).json({ success: false, message: 'Failed to unblock user.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// REPORT A BUG
// POST /api/settings/report-bug
// Body: { category, description, activity?, deviceModel?, androidVersion?, appVersion?, screenshotUrl? }
// ══════════════════════════════════════════════════════════════════════════════
exports.reportBug = async (req, res) => {
  try {
    const {
      category, description, activity,
      deviceModel, androidVersion, appVersion, screenshotUrl
    } = req.body;

    if (!category || !description) {
      return res.status(400).json({ success: false, message: 'Category and description are required.' });
    }

    if (description.length > 300) {
      return res.status(400).json({ success: false, message: 'Description cannot exceed 300 characters.' });
    }

    const report = await BugReport.create({
      userId:        req.userId,
      category,
      description,
      activity:      activity      || null,
      deviceModel:   deviceModel   || null,
      androidVersion: androidVersion || null,
      appVersion:    appVersion    || null,
      screenshotUrl: screenshotUrl || null
    });

    res.status(201).json({
      success: true,
      message: 'Bug report submitted. Thank you for helping us improve Humrah!',
      reportId: report._id
    });

  } catch (err) {
    console.error('reportBug error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit bug report. Please try again.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// GET CURRENT NOTIFICATION SETTINGS (called on screen open)
// GET /api/settings/notifications
// ══════════════════════════════════════════════════════════════════════════════
exports.getNotifications = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('notifications');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    res.json({
      success: true,
      notifications: user.notifications || {
        activityRequests: true,
        gamingAlerts:     true,
        communityActivity: true,
        appUpdates:       true
      }
    });
  } catch (err) {
    console.error('getNotifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch notification settings.' });
  }
};
