// middleware/imageModerationMiddleware.js
const User = require('../models/User');
const { analyzeImageSafety } = require('../services/imageModeration');
const { sendWarningActivity } = require('../utils/sendWarningActivity');

/**
 * Middleware: runs Google Vision SafeSearch on req.body.imageBase64
 * and enforces the 3-strike image blocking system.
 *
 * Must run AFTER auth middleware (needs req.userId).
 * On pass, attaches req.moderationResult and req.moderationPassed = true.
 */
const enforceImageModeration = async (req, res, next) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return next(); // no image — let route handler handle the missing-field error

    // ── Load user ──────────────────────────────────────────────
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    // ── 1. Auto-reset strikes after 30 clean days ──────────────
    if (user.imageStrikeCount > 0 && user.lastImageViolationAt) {
      const daysSince = (Date.now() - new Date(user.lastImageViolationAt)) / 86400000;
      if (daysSince >= 30) {
        user.imageStrikeCount      = 0;
        user.imagePostBlockedUntil = null;
        user.lastImageViolationAt  = null;
        await user.save();
        console.log(`✅ Image strikes auto-reset for user ${user._id} (30-day clean period)`);
      }
    }

    // ── 2. Check if user is currently serving a block ──────────
    if (user.imagePostBlockedUntil && new Date() < new Date(user.imagePostBlockedUntil)) {
      return res.status(403).json({
        success:     false,
        code:        'IMAGE_POST_BLOCKED',
        message:     'Image posting is temporarily disabled due to repeated guideline violations.',
        strikeCount: user.imageStrikeCount,
        blockedUntil: user.imagePostBlockedUntil
      });
    }

    // ── 3. Run SafeSearch ──────────────────────────────────────
    const modResult = await analyzeImageSafety(imageBase64);

    // ── 4. Extreme content → immediate 7-day account suspension ─
    if (modResult.extremeContent) {
      const suspendedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      user.status = 'SUSPENDED';
      user.suspensionInfo = {
        isSuspended:      true,
        suspensionReason: 'Extreme content violation detected in uploaded image',
        suspendedUntil,
        restrictions:     ['post', 'comment', 'chat', 'upload']
      };

      appendModerationLog(user, {
        action:      'EXTREME_CONTENT',
        blockReason: modResult.blockReason,
        strikeCount: user.imageStrikeCount,
        safeSearch:  modResult.scores
      });

      await user.save();
      console.warn(`🚨 Extreme content — user ${user._id} suspended for 7 days`);

      // TODO: trigger push notification 'ACCOUNT_SUSPENDED_7_DAYS' here

      return res.status(403).json({
        success:      false,
        code:         'EXTREME_CONTENT_VIOLATION',
        message:      'Your account has been suspended for 7 days due to severely inappropriate content.',
        suspendedUntil,
        strikeCount:  user.imageStrikeCount
      });
    }

    // ── 5. Standard violation → apply strike ───────────────────
    if (modResult.blocked) {
      user.imageStrikeCount     = Math.min((user.imageStrikeCount || 0) + 1, 3);
      user.lastImageViolationAt = new Date();

      let message = '', blockedUntil = null, notifType = '';

      switch (user.imageStrikeCount) {
        case 1:
          message   = 'Your image was removed for violating our content guidelines. This is your first warning.';
          notifType = 'IMAGE_WARNING_1';
          break;
        case 2:
          message   = 'Your image was removed. This is your second warning — one more violation will result in a temporary posting ban.';
          notifType = 'IMAGE_WARNING_2';
          break;
        case 3:
        default:
          blockedUntil               = new Date(Date.now() + 24 * 60 * 60 * 1000);
          user.imagePostBlockedUntil = blockedUntil;
          message   = 'Your image posting has been disabled for 24 hours due to repeated guideline violations.';
          notifType = 'IMAGE_SUSPENSION_24H';
          break;
      }

      appendModerationLog(user, {
        action:      'BLOCKED',
        blockReason: modResult.blockReason,
        strikeCount: user.imageStrikeCount,
        safeSearch:  modResult.scores
      });

      await user.save();

      // ── ✅ WARNING activity feed entry + push (spec §6) ───────
      sendWarningActivity({ userId: user._id }).catch(e =>
        console.error('[ImageMod] WARNING activity failed:', e.message)
      );

      // TODO: trigger push notification [notifType] here
      console.log(`📣 Notification queued: [${notifType}] for user ${user._id}`);

      return res.status(400).json({
        success:      false,
        code:         'IMAGE_POLICY_VIOLATION',
        message,
        strikeCount:  user.imageStrikeCount,
        blockedUntil: blockedUntil || null
      });
    }

    // ── 6. Passed — log it and continue ────────────────────────
    appendModerationLog(user, {
      action:      'ALLOWED',
      blockReason: null,
      strikeCount: user.imageStrikeCount,
      safeSearch:  modResult.scores
    });
    await user.save();

    req.moderationResult = modResult;
    req.moderationPassed = true;
    next();

  } catch (error) {
    console.error('❌ Image moderation middleware error:', error);
    // Fail open — never block uploads due to internal errors
    req.moderationPassed = true;
    next();
  }
};

// ── Helper: append to imageModerationLog (cap at 20 entries) ──
function appendModerationLog(user, entry) {
  if (!user.imageModerationLog) user.imageModerationLog = [];
  user.imageModerationLog.push({ ...entry, createdAt: new Date() });
  if (user.imageModerationLog.length > 20) {
    user.imageModerationLog = user.imageModerationLog.slice(-20);
  }
}

module.exports = { enforceImageModeration };
