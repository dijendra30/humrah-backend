// routes/users.js - Complete User Routes with FCM Support + LOCATION SUPPORT
// Google Play compliant account deletion added (rate-limited, in-app only)
'use strict';
const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const { deleteMyAccount } = require('../controllers/deleteAccountController');

const { authenticate, adminOnly, auditLog } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimitMiddleware');
const User            = require('../models/User');
const MatchingTodayMood = require('../models/MatchingTodayMood');
const { upload, uploadBuffer, uploadBase64, deleteImage } = require('../config/cloudinary');
const { moderateQuestionnaire, applyStrikesAndEnforce, buildModerationResponse, buildAutoCleanSuccessResponse } = require('../middleware/moderation');
const userActivityCtrl = require('../controllers/userActivityController');

// Mood controller — used for /me/mood + /me/daily-mood (now unified)
const moodCtrl = require('../controllers/matchingMoodController');

// ── Delete-account rate limiter (3 attempts / hour per userId) ────────────────
// Keyed on userId so shared-IP networks (office, college, NAT) are not
// unfairly throttled. The low cap prevents automated abuse while giving a
// genuine user sufficient retries if the first attempt fails due to a transient
// server/network error. Must be applied AFTER authenticate.
const deleteAccountLimiter = rateLimit({
  windowMs:        60 * 60 * 1000, // 1 hour
  max:             3,
  standardHeaders: true,
  legacyHeaders:   false,
  // Key on userId only — never fall back to req.ip.
  // validate.keyGeneratorIpFallback must be false to silence ERR_ERL_KEY_GEN_IPV6
  // even though this keyGenerator never touches req.ip.
  keyGenerator:    (req) => req.userId.toString(),
  skip:            (req) => !req.userId, // unauthenticated requests blocked by authenticate
  validate:        { keyGeneratorIpFallback: false },
  message: {
    success: false,
    message: 'Too many deletion attempts. Please wait an hour and try again.'
  }
});

// ── Activity dashboard ───────────────────────────────────────────────────────
router.get('/activity', authenticate, userActivityCtrl.getUserActivity);

// ==================== USER PROFILE ROUTES ====================

router.put('/me', authenticate, async (req, res) => {
  try {
    const updates        = req.body;
    const allowedUpdates = ['firstName', 'lastName', 'profilePhoto', 'questionnaire'];
    const filteredUpdates = {};
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) filteredUpdates[key] = updates[key];
    });

    if (filteredUpdates.questionnaire && typeof filteredUpdates.questionnaire === 'object') {
      const { cleanedQuestionnaire, violations, errors } = await moderateQuestionnaire(filteredUpdates.questionnaire);
      if (violations.length > 0) {
        const user = await User.findById(req.userId);
        if (user) await user.addModerationStrike(violations, 'PUT /api/users/me');
      }
      if (errors.length > 0) {
        return res.status(422).json({ success: false, code: 'MODERATION_FAILED', message: "Some fields contain content that isn't allowed.", errors });
      }
      filteredUpdates.questionnaire = cleanedQuestionnaire;
    }

    const user = await User.findByIdAndUpdate(req.userId, filteredUpdates, { new: true, runValidators: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, message: 'Profile updated successfully', user });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    // Exclude GPS, legacy dailyMood, fcmTokens, blockedUsers from public profile
    const user = await User.findById(req.params.id)
      .select('-password -last_known_lat -last_known_lng -fcmTokens -blockedUsers -dailyMood -moodRequestsSent');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================================================
// DELETE /api/users/me — Google Play compliant in-app account deletion
//
// Middleware chain:
//   authenticate          → validates JWT, attaches req.userId
//   deleteAccountLimiter  → 3 attempts/hour (keyed on userId)
//   deleteMyAccount       → full data deletion + Cloudinary cleanup
//
// Play Store requirements met:
//   ✅ In-app (no email/external URL redirect)
//   ✅ Permanent deletion for every authenticated user
//   ✅ All personal data deleted or anonymized
//   ✅ enforceLegalAcceptance intentionally NOT applied (must work for all users)
// =============================================================================
router.delete('/me', authenticate, deleteAccountLimiter, deleteMyAccount);

// ==================== LOCATION ROUTE ====================

/**
 * @route   POST /api/users/matchmaking-location
 * @desc    Update user's live location for matchmaking + Surprise Activity.
 *          Called by MatchmakingLocationManager on every app open and on
 *          any trigger where forceRefresh=true (Surprise Meetup screen, etc.).
 *          Writes to both liveLocation (used by /eligible, /nearby) and
 *          legacy last_known_lat/lng fields.
 *          15-min server-side guard prevents unnecessary DB writes when
 *          the client sends the same coords repeatedly.
 */
router.post('/matchmaking-location', authenticate, async (req, res) => {
  try {
    const { lat, lng, city, state } = req.body;

    if (lat === undefined || lng === undefined)
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ success: false, message: 'Invalid coordinates' });

    const now  = new Date();
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;

    // ── Server-side staleness guard ──────────────────────────────────────────
    const user = await User.findById(req.userId).select('liveLocation last_known_lat last_known_lng').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const ll       = user.liveLocation;
    const lastUpd  = ll?.updatedAt ? new Date(ll.updatedAt).getTime() : 0;
    const age      = now.getTime() - lastUpd;
    const latDiff  = Math.abs((ll?.lat || 0) - lat);
    const lngDiff  = Math.abs((ll?.lng || 0) - lng);
    const hasMovedSignificantly = latDiff > 0.001 || lngDiff > 0.001;

    if (age < FIFTEEN_MIN_MS && !hasMovedSignificantly) {
      return res.json({
        success:   true,
        cached:    true,
        message:   'Location is still fresh',
        liveLocation: { lat: ll.lat, lng: ll.lng, city: ll.city, state: ll.state, updatedAt: ll.updatedAt },
      });
    }

    await User.findByIdAndUpdate(req.userId, {
      $set: {
        'liveLocation.lat':       Number(lat),
        'liveLocation.lng':       Number(lng),
        'liveLocation.city':      city  || ll?.city  || null,
        'liveLocation.state':     state || ll?.state || null,
        'liveLocation.updatedAt': now,
        last_known_lat:           Number(lat),
        last_known_lng:           Number(lng),
        last_location_updated_at: now,
      }
    });

    console.log(`[matchmaking-location] updated for ${req.userId}: (${lat}, ${lng}) city=${city || '?'}`);

    return res.json({
      success:     true,
      cached:      false,
      liveLocation: { lat: Number(lat), lng: Number(lng), city: city || null, state: state || null, updatedAt: now },
    });

  } catch (error) {
    console.error('❌ matchmaking-location update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating live location' });
  }
});

router.post('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined)
      return res.status(400).json({ success: false, message: 'Latitude and longitude are required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ success: false, message: 'Invalid latitude or longitude values' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.updateLocation(lat, lng);
    await user.save();

    res.json({
      success: true,
      message: 'Location updated successfully',
      location: { last_known_lat: user.last_known_lat, last_known_lng: user.last_known_lng, last_location_updated_at: user.last_location_updated_at }
    });
  } catch (error) {
    console.error('❌ Location update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating location' });
  }
});

// ==================== FCM TOKEN MANAGEMENT ====================

router.post('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ success: false, message: 'FCM token is required' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.fcmTokens) user.fcmTokens = [];
    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
      if (user.fcmTokens.length > 5) user.fcmTokens = user.fcmTokens.slice(-5);
      await user.save();
    }
    res.json({ success: true, message: 'FCM token registered successfully' });
  } catch (error) {
    console.error('❌ FCM token registration error:', error);
    res.status(500).json({ success: false, message: 'Failed to register FCM token' });
  }
});

router.delete('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ success: false, message: 'FCM token is required' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.fcmTokens) {
      user.fcmTokens = user.fcmTokens.filter(t => t !== fcmToken);
      await user.save();
    }
    res.json({ success: true, message: 'FCM token removed successfully' });
  } catch (error) {
    console.error('❌ FCM token removal error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove FCM token' });
  }
});

// ==================== PHOTO UPLOAD ROUTES ====================

router.post('/upload-profile-photo', authenticate, uploadLimiter, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No photo uploaded' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.profilePhotoPublicId) await deleteImage(user.profilePhotoPublicId);
    const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/profiles');

    user.profilePhoto = uploadResult.url;
    user.profilePhotoPublicId = uploadResult.publicId;
    user.profileEditStats.lastPhotoUpdate = new Date();
    user.verified = false;
    user.photoVerificationStatus = 'not_submitted';
    user.verificationPhotoSubmittedAt = null;
    user.photoVerifiedAt = null;
    user.photoVerifiedBy = null;
    user.photoRejectionReason = null;
    await user.save();

    res.json({ success: true, message: 'Profile photo uploaded successfully', profilePhoto: user.profilePhoto, photoVerificationStatus: user.photoVerificationStatus, lastPhotoUpdate: user.profileEditStats.lastPhotoUpdate });
  } catch (error) {
    console.error('Upload profile photo error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading photo' });
  }
});

router.post('/upload-profile-photo-base64', authenticate, uploadLimiter, async (req, res) => {
  try {
    const { photoBase64 } = req.body;
    if (!photoBase64) return res.status(400).json({ success: false, message: 'No photo data provided' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.profilePhotoPublicId) await deleteImage(user.profilePhotoPublicId);
    const uploadResult = await uploadBase64(photoBase64, 'humrah/profiles');

    user.profilePhoto = uploadResult.url;
    user.profilePhotoPublicId = uploadResult.publicId;
    user.profileEditStats.lastPhotoUpdate = new Date();
    user.verified = false;
    user.photoVerificationStatus = 'not_submitted';
    user.verificationPhotoSubmittedAt = null;
    user.photoVerifiedAt = null;
    user.photoVerifiedBy = null;
    user.photoRejectionReason = null;
    await user.save();

    res.json({ success: true, message: 'Profile photo uploaded successfully', profilePhoto: user.profilePhoto, photoVerificationStatus: user.photoVerificationStatus, lastPhotoUpdate: user.profileEditStats.lastPhotoUpdate });
  } catch (error) {
    console.error('Upload profile photo error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading photo' });
  }
});

router.post('/submit-verification-photo', authenticate, uploadLimiter, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No photo uploaded' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.verificationPhotoPublicId) await deleteImage(user.verificationPhotoPublicId);
    const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/verification');

    user.verificationPhoto = uploadResult.url;
    user.verificationPhotoPublicId = uploadResult.publicId;
    user.verificationPhotoSubmittedAt = new Date();
    user.photoVerificationStatus = 'pending';
    await user.save();

    res.json({ success: true, message: 'Verification photo submitted successfully. Our team will review it soon.', verificationPhoto: user.verificationPhoto, photoVerificationStatus: user.photoVerificationStatus });
  } catch (error) {
    console.error('Submit verification photo error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/submit-verification-photo-base64', authenticate, uploadLimiter, async (req, res) => {
  try {
    const { photoBase64 } = req.body;
    if (!photoBase64) return res.status(400).json({ success: false, message: 'No photo data provided' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.verificationPhotoPublicId) await deleteImage(user.verificationPhotoPublicId);
    const uploadResult = await uploadBase64(photoBase64, 'humrah/verification');

    user.verificationPhoto = uploadResult.url;
    user.verificationPhotoPublicId = uploadResult.publicId;
    user.verificationPhotoSubmittedAt = new Date();
    user.photoVerificationStatus = 'pending';
    await user.save();

    res.json({ success: true, message: 'Verification photo submitted successfully. Our team will review it soon.', verificationPhoto: user.verificationPhoto, photoVerificationStatus: user.photoVerificationStatus });
  } catch (error) {
    console.error('Submit verification photo error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== QUESTIONNAIRE ROUTES ====================

router.put('/me/questionnaire', authenticate, async (req, res) => {
  try {
    const { questionnaire } = req.body;
    if (!questionnaire || typeof questionnaire !== 'object')
      return res.status(400).json({ success: false, message: 'Questionnaire data is required' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { cleanedQuestionnaire, violations, errors, autoCleanedFields } = await moderateQuestionnaire(questionnaire);

    // ── Language field backward-compat migration ──────────────────────────────
    // Old clients (pre-update) may send languagePreference: "Hindi" (String).
    // New clients send preferredLanguages: ["Hindi", "English"] (Array).
    // We auto-promote the legacy field on every save so the DB is always
    // canonical, regardless of which client version made the request.
    if (cleanedQuestionnaire.languagePreference &&
        (!cleanedQuestionnaire.preferredLanguages || cleanedQuestionnaire.preferredLanguages.length === 0)) {
      const legacy = (cleanedQuestionnaire.languagePreference || '').trim();
      if (legacy === 'Both' || legacy === 'English & Hindi' || legacy === 'English & hindi') {
        cleanedQuestionnaire.preferredLanguages = ['Hindi', 'English'];
      } else if (legacy) {
        cleanedQuestionnaire.preferredLanguages = [legacy];
      }
      // languagePreference is kept as-is for backward-compat reads by old clients
    }
    let enforcement = { enforced: false, action: null, message: null, suspendUntil: null };
    if (violations.length > 0) {
      enforcement = await applyStrikesAndEnforce(user, violations, 'PUT /api/users/me/questionnaire');
    }
    if (errors.length > 0) {
      return res.status(422).json(buildModerationResponse(errors, enforcement, autoCleanedFields));
    }

    user.questionnaire = { ...(user.questionnaire?.toObject?.() || user.questionnaire || {}), ...cleanedQuestionnaire };
    user.markModified('questionnaire');
    await user.save();

    const successResponse = buildAutoCleanSuccessResponse(autoCleanedFields || []);
    res.json({ ...successResponse, message: 'Questionnaire saved successfully', user });
  } catch (error) {
    console.error('Save questionnaire error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== ADMIN ROUTES ====================

router.put('/:userId/verify-photo', authenticate, adminOnly, auditLog('VERIFY_USER_PHOTO', 'USER'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { approved } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.verificationPhoto) return res.status(400).json({ success: false, message: 'No verification photo to review' });

    user.photoVerificationStatus = approved ? 'approved' : 'rejected';
    user.photoVerifiedAt  = new Date();
    user.photoVerifiedBy  = req.userId;
    user.verified         = user.isFullyVerified();
    await user.save();

    res.json({ success: true, message: `Photo verification ${approved ? 'approved' : 'rejected'} successfully`, user: { id: user._id, photoVerificationStatus: user.photoVerificationStatus, verified: user.verified, photoVerifiedAt: user.photoVerifiedAt } });
  } catch (error) {
    console.error('Verify photo error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/admin/pending-verifications', authenticate, adminOnly, async (req, res) => {
  try {
    const users = await User.find({ photoVerificationStatus: 'pending', verificationPhoto: { $ne: null } })
      .select('firstName lastName email verificationPhoto verificationPhotoSubmittedAt')
      .sort({ verificationPhotoSubmittedAt: -1 });
    res.json({ success: true, count: users.length, users });
  } catch (error) {
    console.error('Get pending verifications error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== MOOD ROUTES ====================

router.put('/me/mood', authenticate, moodCtrl.goLive);

router.get('/me/daily-mood', authenticate, async (req, res) => {
  try {
    const now      = new Date();
    const doc      = await MatchingTodayMood.findOne({ userId: req.userId }).lean();
    const isActive = !!(doc?.visible && doc?.expiresAt && new Date(doc.expiresAt) > now);

    res.json({
      success:  true,
      isActive,
      dailyMood: doc ? {
        mood:      doc.mood,
        vibeLevel: doc.vibeLevel,
        intention: doc.intention,
        visible:   doc.visible,
        expiresAt: doc.expiresAt,
      } : null,
    });
  } catch (error) {
    console.error('Get daily mood error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== HOST STATUS ROUTE ====================

router.patch('/host-status', authenticate, async (req, res) => {
  try {
    const { hostActive } = req.body;
    if (typeof hostActive !== 'boolean')
      return res.status(400).json({ success: false, message: 'hostActive must be a boolean value' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.userType !== 'COMPANION')
      return res.status(403).json({ success: false, message: 'Only Activity Hosts can toggle host mode' });

    user.hostActive = hostActive;
    await user.save();

    if (!hostActive) {
      try {
        const Booking = require('../models/Booking');
        await Booking.updateMany({ companion: req.userId, status: 'pending' }, { status: 'expired', expiredReason: 'host_went_offline' });
      } catch (_) { /* non-critical */ }
    }

    res.json({ success: true, hostActive: user.hostActive, message: hostActive ? "You're now visible for activity bookings." : "Hosting paused. You're no longer visible for activity bookings." });
  } catch (error) {
    console.error('Host status update error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== ACTIVITY & PRIVACY ====================

router.get('/me/activity-privacy', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .select('hiddenPosts blockedUsers mutedUsers')
      .populate('blockedUsers', 'firstName lastName profilePhoto')
      .populate('mutedUsers',   'firstName lastName profilePhoto');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, hiddenPostIds: (user.hiddenPosts || []).map(id => id.toString()), blockedUsers: user.blockedUsers || [], mutedUsers: user.mutedUsers || [] });
  } catch (err) {
    console.error('Activity privacy error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/me/blocked/:userId', authenticate, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { $pull: { blockedUsers: req.params.userId } });
    res.json({ success: true, message: 'User unblocked' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/me/muted/:userId', authenticate, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { $pull: { mutedUsers: req.params.userId } });
    res.json({ success: true, message: 'User unmuted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
