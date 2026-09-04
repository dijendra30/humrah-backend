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
const crypto = require('crypto');
const ModerationLog = require('../models/ModerationLog');
const ModerationCache = require('../models/ModerationCache');
const { checkWithOpenAI, checkWithLlamaGuard, moderateQuestionnaireSync, applyStrikesAndEnforce, buildModerationResponse, buildAutoCleanSuccessResponse } = require('../middleware/moderation');
// ✅ Atomic, geocode-first live location update — single source of truth
// shared with routes/liveLocationMatchmaking.js (see services/liveLocationService.js)
const { updateUserLiveLocation } = require('../services/liveLocationService');

const normalizeCostSharingPreference = (val) => {
  if (!val || typeof val !== 'string') return null;
  const lower = val.trim().toLowerCase();
  
  const validEnums = ['FREE_ONLY', 'SPLIT_FAIRLY', 'DEPENDS_ON_ACTIVITY', 'HOST_COVERS', 'DISCUSS_FIRST'];
  if (validEnums.includes(val)) return val;
  
  if (lower.includes('split')) return 'SPLIT_FAIRLY';
  if (lower.includes('free')) return 'FREE_ONLY';
  if (lower.includes('host')) return 'HOST_COVERS';
  if (lower.includes('depend')) return 'DEPENDS_ON_ACTIVITY';
  if (lower.includes('discuss')) return 'DISCUSS_FIRST';
  
  return null;
};
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

// ── Accept Community Guidelines ──────────────────────────────────────────────
router.post('/accept-guidelines', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    // The server controls the version
    const CURRENT_GUIDELINES_VERSION = "1.0"; 
    
    user.guidelinesAccepted = true;
    user.guidelinesAcceptedAt = new Date();
    user.guidelinesVersion = CURRENT_GUIDELINES_VERSION;
    
    await user.save();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Accept guidelines error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/me', authenticate, async (req, res) => {
  try {
    const updates        = req.body;
    const allowedUpdates = ['firstName', 'lastName', 'profilePhoto', 'questionnaire'];
    const filteredUpdates = {};
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) filteredUpdates[key] = updates[key];
    });

    if (filteredUpdates.questionnaire && typeof filteredUpdates.questionnaire === 'object') {
      const { cleanedQuestionnaire, violations, errors, textsForAI } = moderateQuestionnaireSync(filteredUpdates.questionnaire);
      if (violations.length > 0) {
        const user = await User.findById(req.userId);
        if (user) await applyStrikesAndEnforce(user, violations, 'PUT /api/users/me');
      }
      if (errors.length > 0) {
        return res.status(422).json({ success: false, code: 'MODERATION_FAILED', message: "Some fields contain content that isn't allowed.", errors });
      }
      filteredUpdates.questionnaire = cleanedQuestionnaire;
      
      const user = await User.findById(req.userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      
      const changedFields = [];
      if (textsForAI) {
        for (const [field, text] of Object.entries(textsForAI)) {
          const existingText = user.questionnaire?.[field] || '';
          if (text !== existingText) {
            changedFields.push({ path: `questionnaire.${field}`, value: text });
          }
        }
      }

      if (changedFields.length > 0) {
        filteredUpdates.moderationStatus = 'pending_review';
        const ModerationTask = require('../models/ModerationTask');
        await ModerationTask.create({
          userId: user._id,
          documentType: 'questionnaire',
          fields: changedFields
        });
      }
    }

    const updatedUser = await User.findByIdAndUpdate(req.userId, filteredUpdates, { new: true, runValidators: true }).select('-password');
    if (!updatedUser) return res.status(404).json({ success: false, message: 'User not found' });
    
    console.log(`[GUIDELINES]
userId=${updatedUser._id}
guidelinesAccepted=${updatedUser.guidelinesAccepted || false}
guidelinesVersion=${updatedUser.guidelinesVersion || null}
acceptedCommunityVersion=${updatedUser.acceptedCommunityVersion || null}
needsGuidelinesAcceptance=${updatedUser.needsGuidelinesAcceptance !== undefined ? updatedUser.needsGuidelinesAcceptance : (!updatedUser.guidelinesAccepted || updatedUser.guidelinesVersion !== "1.0")}`);
    const userObj = updatedUser.toObject();
    userObj.needsGuidelinesAcceptance = !updatedUser.guidelinesAccepted || updatedUser.guidelinesVersion !== "1.0";

    res.json({ success: true, message: 'Profile updated successfully', user: userObj });

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
    
    console.log(`[GUIDELINES]
userId=${user._id}
guidelinesAccepted=${user.guidelinesAccepted || false}
guidelinesVersion=${user.guidelinesVersion || null}
acceptedCommunityVersion=${user.acceptedCommunityVersion || null}
needsGuidelinesAcceptance=${user.needsGuidelinesAcceptance !== undefined ? user.needsGuidelinesAcceptance : (!user.guidelinesAccepted || user.guidelinesVersion !== "1.0")}`);
    const userObj = user.toObject();
    userObj.needsGuidelinesAcceptance = !user.guidelinesAccepted || user.guidelinesVersion !== "1.0";

    res.json({ success: true, user: userObj });
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
//
// ⚠️ FIXED: this endpoint used to call the legacy user.updateLocation(lat, lng)
// helper, which wrote ONLY last_known_lat/last_known_lng and never touched
// liveLocation.city/state/displayName. That is exactly what caused the bug
// where lat/lng updated instantly but the displayed city stayed stale.
//
// Now it goes through the SAME atomic, geocode-first service used by
// /api/users/matchmaking-location, so lat/lng and city/state can never
// diverge no matter which endpoint the client calls.
router.post('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined)
      return res.status(400).json({ success: false, message: 'Latitude and longitude are required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ success: false, message: 'Invalid latitude or longitude values' });

    const result = await updateUserLiveLocation(req.userId, lat, lng);

    if (!result.success) {
      // Reverse geocoding failed — previous liveLocation (city/state/displayName)
      // was left completely untouched. Tell Android to retry, never show a
      // half-updated location.
      return res.status(503).json({
        success:      false,
        message:      result.message || 'Could not update location. Please try again.',
        retry:        true,
        liveLocation: result.liveLocation || null
      });
    }

    res.json({
      success: true,
      message: 'Location updated successfully',
      location: {
        last_known_lat:           result.liveLocation.lat,
        last_known_lng:           result.liveLocation.lng,
        last_location_updated_at: result.liveLocation.updatedAt
      },
      liveLocation: result.liveLocation
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

    res.json({ success: true, message: 'Profile photo uploaded successfully', profilePhoto: user.profilePhoto, photoVerificationStatus: user.photoVerificationStatus, lastPhotoUpdate: user.profileEditStats.lastPhotoUpdate, profileCompletion: user.profileCompletion, profileCompletionBreakdown: user.profileCompletionBreakdown, missingFields: user.missingFields });
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

    res.json({ success: true, message: 'Profile photo uploaded successfully', profilePhoto: user.profilePhoto, photoVerificationStatus: user.photoVerificationStatus, lastPhotoUpdate: user.profileEditStats.lastPhotoUpdate, profileCompletion: user.profileCompletion, profileCompletionBreakdown: user.profileCompletionBreakdown, missingFields: user.missingFields });
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
    console.log(`[Upload Lifecycle] Saving verificationPhotoPublicId to MongoDB for user ${user._id}: ${user.verificationPhotoPublicId}`);
    await user.save();

    res.json({ success: true, message: 'Verification photo submitted successfully. Our team will review it soon.', verificationPhoto: user.verificationPhoto, photoVerificationStatus: user.photoVerificationStatus, profileCompletion: user.profileCompletion, profileCompletionBreakdown: user.profileCompletionBreakdown, missingFields: user.missingFields });
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
    console.log(`[Upload Lifecycle] Saving verificationPhotoPublicId (base64) to MongoDB for user ${user._id}: ${user.verificationPhotoPublicId}`);
    await user.save();

    res.json({ success: true, message: 'Verification photo submitted successfully. Our team will review it soon.', verificationPhoto: user.verificationPhoto, photoVerificationStatus: user.photoVerificationStatus, profileCompletion: user.profileCompletion, profileCompletionBreakdown: user.profileCompletionBreakdown, missingFields: user.missingFields });
  } catch (error) {
    console.error('Submit verification photo error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== QUESTIONNAIRE ROUTES ====================

router.get('/me/next-profile-question', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const q = user.questionnaire || {};

    const isUnanswered = (key, type) => {
      const val = q[key];
      if (val === undefined || val === null) return true;
      if (typeof val === 'string') return val.trim().length === 0;
      if (Array.isArray(val)) return val.length === 0;
      return false;
    };

    // Exactly 19 launch questions (Screens 1-4)
    const progressivePool = [
      { id: 10, key: 'dateOfBirth', type: 'string' },
      { id: 2, key: 'city', type: 'string' },
      { id: 3, key: 'preferredLanguages', type: 'array' },
      { id: 25, key: 'gender', type: 'string' },
      
      { id: 5, key: 'availableTimes', type: 'array' },
      { id: 8, key: 'vibeWords', type: 'array' },
      { id: 11, key: 'conversationInterests', type: 'array' },
      { id: 24, key: 'humrahRoomInterests', type: 'array' },
      
      { id: 12, key: 'movieGenre', type: 'array' },
      { id: 13, key: 'favoriteFood', type: 'array' },
      { id: 14, key: 'hobbies', type: 'array' },
      
      { id: 15, key: 'travelPreference', type: 'string' },
      { id: 17, key: 'socialVibe', type: 'string' },
      { id: 18, key: 'comfortZones', type: 'array' },
      { id: 19, key: 'budgetComfort', type: 'string' },
      { id: 20, key: 'hangoutFrequency', type: 'string' },
      { id: 21, key: 'comfortActivity', type: 'array' },
      { id: 22, key: 'relaxActivity', type: 'array' },
      { id: 23, key: 'musicPreference', type: 'array' }
    ];

    // Priority to Q24
    let nextQuestion = null;
    const q24 = progressivePool.find(p => p.id === 24);
    if (q24 && isUnanswered(q24.key, q24.type)) {
      nextQuestion = q24;
    } else {
      // Find remaining unanswered
      const unanswered = progressivePool.filter(p => p.id !== 24 && isUnanswered(p.key, p.type));
      if (unanswered.length > 0) {
        // Randomly select one
        const randomIndex = Math.floor(Math.random() * unanswered.length);
        nextQuestion = unanswered[randomIndex];
      }
    }

    if (!nextQuestion) {
      return res.json({ success: true, message: 'No eligible progressive questions available', question: null });
    }

    res.json({
      success: true,
      question: {
        id: nextQuestion.id,
        backendKey: nextQuestion.key
      }
    });
  } catch (error) {
    console.error('Next profile question error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/me/questionnaire', authenticate, async (req, res) => {
  try {
    const questionnaire = req.body.questionnaire !== undefined ? req.body.questionnaire : req.body;

    if (!questionnaire || typeof questionnaire !== 'object') {
      return res.status(400).json({ success: false, message: 'Questionnaire data is required' });
    }

    // --- EXTRACT INCOMING UPDATES (FILTER NULL AND UNDEFINED) ---
    // Retrofit Gson serializes unset fields as null when .serializeNulls() is enabled.
    // Discard null and undefined so they don't overwrite existing answers or cause TypeErrors.
    const incomingUpdates = {};
    for (const [key, value] of Object.entries(questionnaire)) {
      if (value !== null && value !== undefined) {
        incomingUpdates[key] = value;
      }
    }

    // --- FIELD SCHEMA TYPE NORMALIZATION ---
    const ARRAY_FIELDS = [
      'preferredLanguages', 'hangoutPreferences', 'availableTimes', 'lookingForOnHumrah',
      'vibeWords', 'comfortActivity', 'relaxActivity', 'musicPreference', 'comfortZones',
      'openFor', 'interests', 'hobbies', 'conversationInterests', 'humrahRoomInterests',
      'socialActivities'
    ];
    const STRING_FIELDS = [
      'name', 'city', 'languagePreference', 'meetupPreference', 'publicPlacesOnly',
      'ageGroup', 'state', 'area', 'bio', 'goodMeetupMeaning', 'vibeQuote',
      'budgetComfort', 'hangoutFrequency', 'becomeCompanion', 'availability',
      'price', 'costSharingPreference', 'tagline', 'verifyIdentity',
      'understandGuidelines', 'mood', 'personalityType', 'gender', 'dateOfBirth',
      'language', 'socialVibe', 'movieGenre', 'favoriteFood', 'travelPreference',
      'petPreference', 'fitnessLevel', 'smokingStatus', 'drinkingStatus',
      'relationshipStatus', 'lookingFor', 'connectAndEarn', 'profession',
      'education', 'income'
    ];

    for (const field of ARRAY_FIELDS) {
      if (incomingUpdates[field] !== undefined) {
        if (typeof incomingUpdates[field] === 'string') {
          incomingUpdates[field] = incomingUpdates[field]
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        } else if (Array.isArray(incomingUpdates[field])) {
          incomingUpdates[field] = incomingUpdates[field]
            .map(s => (typeof s === 'string' ? s.trim() : String(s)))
            .filter(Boolean);
        }
      }
    }

    for (const field of STRING_FIELDS) {
      if (incomingUpdates[field] !== undefined) {
        if (Array.isArray(incomingUpdates[field])) {
          incomingUpdates[field] = incomingUpdates[field].filter(Boolean).join(', ');
        } else if (typeof incomingUpdates[field] === 'string') {
          incomingUpdates[field] = incomingUpdates[field].trim();
        }
      }
    }

    // --- COST SHARING PREFERENCE MIGRATION & VALIDATION ---
    const validEnums = ['FREE_ONLY', 'SPLIT_FAIRLY', 'DEPENDS_ON_ACTIVITY', 'HOST_COVERS', 'DISCUSS_FIRST'];
    if (incomingUpdates.costSharingPreference !== undefined) {
      if (!validEnums.includes(incomingUpdates.costSharingPreference)) {
        return res.status(400).json({ success: false, error: 'Invalid cost sharing preference.' });
      }
    } else if (incomingUpdates.price) {
      // Legacy text fallback migration
      incomingUpdates.costSharingPreference = normalizeCostSharingPreference(incomingUpdates.price);
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const existingQ = user.questionnaire?.toObject?.() || user.questionnaire || {};

    // --- EXTRACT CHANGED FIELDS ONLY ---
    const changedQuestionnaire = {};
    for (const [key, value] of Object.entries(incomingUpdates)) {
      const existingVal = existingQ[key];
      let isDifferent = false;
      if (Array.isArray(value) && Array.isArray(existingVal)) {
        if (value.length !== existingVal.length || value.some((v, idx) => v !== existingVal[idx])) {
          isDifferent = true;
        }
      } else if (value !== existingVal) {
        isDifferent = true;
      }
      if (isDifferent) {
        changedQuestionnaire[key] = value;
      }
    }

    // --- PROFILE TEXT QUALITY VALIDATION (ONLY ON CHANGED STRING VALUES) ---
    const isSpam = (text) => {
      if (!text || typeof text !== 'string') return false;
      const t = text.trim();
      if (!t) return true; // whitespace only
      if (/^[^ws]+$/.test(t)) return true; // punctuation only
      if (/^(.)\1+$/.test(t)) return true; // repeated single char
      return false;
    };

    if (typeof changedQuestionnaire.bio === 'string') {
      const text = changedQuestionnaire.bio.trim();
      if (isSpam(text) || text.length < 20 || text.length > 150) {
        return res.status(400).json({ success: false, message: 'Bio must be between 20 and 150 characters.' });
      }
    }
    if (typeof changedQuestionnaire.goodMeetupMeaning === 'string') {
      const text = changedQuestionnaire.goodMeetupMeaning.trim();
      const words = text.split(/\s+/).filter(w => w.length > 0);
      if (isSpam(text) || (text.length < 10 && words.length < 3)) {
        return res.status(400).json({ success: false, message: 'Hangout answer must contain at least 10 characters or 3 meaningful words.' });
      }
    }
    if (typeof changedQuestionnaire.vibeQuote === 'string') {
      const text = changedQuestionnaire.vibeQuote.trim();
      if (isSpam(text) || text.length < 5 || text.length > 100) {
        return res.status(400).json({ success: false, message: 'Quote must be between 5 and 100 characters.' });
      }
    }

    // --- MODERATE CHANGED FIELDS ---
    const { cleanedQuestionnaire, violations, errors, autoCleanedFields, textsForAI } = moderateQuestionnaireSync(changedQuestionnaire);

    // --- SYNCHRONOUS AI MODERATION ---
    if (textsForAI && Object.keys(textsForAI).length > 0) {
      const contentString = Object.entries(textsForAI).map(([f, t]) => `[${f}]: ${t}`).join('\n---\n');
      const contentHash = crypto.createHash('sha256').update(contentString).digest('hex');

      let finalDecision = 'APPROVE';
      let providerUsed = 'Multiple';
      let openAiRes = null;
      let llamaRes = null;
      let ruleRes = violations.length > 0 ? { flagged: true, violations } : { flagged: false };

      let openAiFailed = false;
      let llamaFailed = false;
      let oaiError = null;
      let llamaError = null;

      const cached = await ModerationCache.findOne({ contentHash });
      if (cached) {
        providerUsed = 'Cache';
        finalDecision = cached.decision;
        openAiRes = cached.openAiResult;
        llamaRes = cached.llamaGuardResult;
        ruleRes = cached.ruleEngineResult;
      } else {
        if (violations.length > 0) {
          finalDecision = 'REJECT'; // Humrah rules triggered
        } else {
          // OpenAI Layer
          const aiResult = await Promise.race([
            checkWithOpenAI(textsForAI),
            new Promise((resolve) => setTimeout(() => resolve({ safe: true, _timeout: true }), 5000))
          ]).catch((err) => {
            openAiFailed = true;
            oaiError = err;
            return { safe: true, _error: err.message };
          });
          
          if (aiResult._timeout) openAiFailed = true;
          openAiRes = aiResult;
          
          if (!aiResult.safe) {
            finalDecision = 'REJECT';
          } else {
            // Llama Guard Layer (Only if OpenAI passes)
            const llamaResult = await Promise.race([
              checkWithLlamaGuard(textsForAI),
              new Promise((resolve) => setTimeout(() => resolve({ safe: true, _timeout: true }), 5000))
            ]).catch((err) => {
              llamaFailed = true;
              llamaError = err;
              return { safe: true, _error: err.message };
            });
            
            if (llamaResult._timeout) llamaFailed = true;
            llamaRes = llamaResult;
            
            if (!llamaResult.safe) {
              finalDecision = 'REJECT';
            }
          }
          
          if (openAiFailed && llamaFailed && finalDecision !== 'REJECT') {
            finalDecision = 'PENDING_REVIEW';
          }
        }
        
        await ModerationCache.updateOne(
          { contentHash },
          { contentHash, decision: finalDecision, openAiResult: openAiRes, llamaGuardResult: llamaRes, ruleEngineResult: ruleRes },
          { upsert: true }
        );
      }

      await ModerationLog.create({
        userId: user._id,
        contentHash,
        providerUsed,
        model: 'omni-moderation-latest, @cf/meta/llama-guard-3-8b',
        statusCode: oaiError?.providerStatusCode || llamaError?.providerStatusCode || 200,
        responseBody: oaiError?.providerResponseBody || llamaError?.providerResponseBody || null,
        openAiResult: openAiRes,
        llamaGuardResult: llamaRes,
        ruleEngineResult: ruleRes,
        finalDecision,
        retryCount: 0
      });

      if (finalDecision === 'REJECT') {
        return res.status(400).json({ 
          success: false, 
          message: 'Your answer may violate Humrah\'s Community Guidelines. Please remove inappropriate language, contact information, hate speech, harassment, scams, or solicitation before continuing.' 
        });
      } else if (finalDecision === 'PENDING_REVIEW') {
        user.moderationStatus = 'pending_review';
        // Allow onboarding to continue by NOT returning an error.
      }
    }

    // --- ONBOARDING COMPLIANCE: Age & Consent Validation ---
    const reqDob = req.body.dateOfBirth || incomingUpdates.dateOfBirth;
    const reqIsAdult = req.body.isAdultConfirmed !== undefined ? req.body.isAdultConfirmed : incomingUpdates.isAdultConfirmed;
    const reqConsent = req.body.consentAccepted !== undefined ? req.body.consentAccepted : incomingUpdates.consentAccepted;

    // Only process this block if we are actually receiving Dob (which means it's Onboarding) 
    // OR if they are explicitly sending true for the consents.
    if (reqDob || reqIsAdult === true || reqConsent === true) {
      if (reqDob) {
        let normalizedDob = reqDob;
        // Fix for Android sending DD/MM/YYYY format
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(reqDob)) {
          const parts = reqDob.split('/');
          normalizedDob = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        
        const birthDate = new Date(normalizedDob);
        if (!isNaN(birthDate.getTime())) {
          let age = new Date().getFullYear() - birthDate.getFullYear();
          const m = new Date().getMonth() - birthDate.getMonth();
          if (m < 0 || (m === 0 && new Date().getDate() < birthDate.getDate())) {
            age--;
          }
          if (age < 18) {
            return res.status(400).json({ success: false, message: 'Humrah is available only for users aged 18 and above.' });
          }
          
          // Compute ageGroup on backend just in case Android failed to send it
          let ageGroup = null;
          if (age >= 18 && age <= 24) ageGroup = '18-24';
          else if (age >= 25 && age <= 34) ageGroup = '25-34';
          else if (age >= 35 && age <= 44) ageGroup = '35-44';
          else if (age >= 45 && age <= 54) ageGroup = '45-54';
          else if (age >= 55) ageGroup = '55+';

          cleanedQuestionnaire.dateOfBirth = normalizedDob;
          cleanedQuestionnaire.age = age;
          if (ageGroup) cleanedQuestionnaire.ageGroup = ageGroup;
          cleanedQuestionnaire.isAdultConfirmed = true;
        }
      }

      // If the user already has isAdultConfirmed in the DB, or if reqIsAdult evaluates to true
      const finalIsAdult = reqIsAdult === true || cleanedQuestionnaire.isAdultConfirmed === true || existingQ.isAdultConfirmed === true;
      const finalConsent = reqConsent === true || existingQ.consentAccepted === true || user.guidelinesAccepted === true;

      // Only strictly block if it's the onboarding flow where adult or consent isn't satisfied
      if (reqDob && (!finalIsAdult || !finalConsent)) {
        if (cleanedQuestionnaire.isAdultConfirmed) {
          cleanedQuestionnaire.consentAccepted = true;
        } else {
          console.log('[DEBUG] 400 - Consent/Adult confirmation missing during onboarding. reqIsAdult:', reqIsAdult, 'reqConsent:', reqConsent);
          return res.status(400).json({ success: false, message: 'Consent and adult confirmation are required.' });
        }
      }

      if (finalIsAdult) cleanedQuestionnaire.isAdultConfirmed = true;
      if (finalConsent) cleanedQuestionnaire.consentAccepted = true;
      
      if (finalConsent && !existingQ.consentTimestamp && !cleanedQuestionnaire.consentTimestamp) {
        cleanedQuestionnaire.consentTimestamp = new Date();
      }
    }
    // --- END ONBOARDING COMPLIANCE ---

    // ── Language field backward-compat migration ──────────────────────────────
    if (cleanedQuestionnaire.languagePreference &&
        (!cleanedQuestionnaire.preferredLanguages || cleanedQuestionnaire.preferredLanguages.length === 0)) {
      const legacy = (cleanedQuestionnaire.languagePreference || '').trim();
      if (legacy === 'Both' || legacy === 'English & Hindi' || legacy === 'English & hindi') {
        cleanedQuestionnaire.preferredLanguages = ['Hindi', 'English'];
      } else if (legacy) {
        cleanedQuestionnaire.preferredLanguages = [legacy];
      }
    }

    // --- SAFE SERVER-SIDE MERGE ---
    // Start with existing questionnaire fields from MongoDB so partial updates never erase fields
    const updatedQuestionnaire = { ...existingQ };
    for (const [k, v] of Object.entries(cleanedQuestionnaire)) {
      if (v !== null && v !== undefined) {
        updatedQuestionnaire[k] = v;
      }
    }

    // Ensure costSharingPreference is normalized to canonical enum or null
    if (updatedQuestionnaire.costSharingPreference !== undefined) {
      updatedQuestionnaire.costSharingPreference = normalizeCostSharingPreference(updatedQuestionnaire.costSharingPreference);
    }

    user.questionnaire = updatedQuestionnaire;
    user.markModified('questionnaire');

    // Mongoose pre('save') hook will now recalculate user.profileCompletion automatically
    await user.save();

    const successResponse = buildAutoCleanSuccessResponse(autoCleanedFields || []);
    res.json({ ...successResponse, message: 'Questionnaire saved successfully', user });
  } catch (error) {
    console.error('Save questionnaire error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors || {}).map(e => e.message);
      return res.status(400).json({ success: false, message: messages.join('; ') || 'Validation error' });
    }
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

    res.json({ success: true, message: `Photo verification ${approved ? 'approved' : 'rejected'} successfully`, user: { id: user._id, photoVerificationStatus: user.photoVerificationStatus, verified: user.verified, photoVerifiedAt: user.photoVerifiedAt, profileCompletion: user.profileCompletion, profileCompletionBreakdown: user.profileCompletionBreakdown, missingFields: user.missingFields } });
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

// =============================================
// AI PROMPT REMINDER ROUTES (DEPRECATED / NEUTRALIZED IN PHASE 2.5)
// =============================================
// The legacy AI prompt reminder system is retired in favor of the launch Progressive Questionnaire.
// Neutralized safely for backward compatibility with older Android builds.
router.get('/check-prompt-reminder', authenticate, async (req, res) => {
  try {
    return res.json({ shouldShow: false });
  } catch (error) {
    console.error('Check prompt reminder error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/defer-prompt', authenticate, async (req, res) => {
  try {
    res.json({ success: true });
  } catch (error) {
    console.error('Defer prompt error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
