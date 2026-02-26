// routes/users.js - Complete User Routes with FCM Support + LOCATION SUPPORT
const express = require('express');
const router = express.Router();
const axios = require('axios');

// ✅ Import middleware
const { authenticate, authorize, adminOnly, superAdminOnly, auditLog } = require('../middleware/auth');

const User = require('../models/User');
const { upload, uploadBuffer, uploadBase64, deleteImage } = require('../config/cloudinary');

// =============================================
// SHARED MODERATION ENGINE
// Applies to ALL routes that save questionnaire text fields.
// Same logic as profile.js — kept in sync here.
// Fields: bio, goodMeetupMeaning, vibeQuote
// =============================================

const MODERATED_TEXT_FIELDS = ['bio', 'goodMeetupMeaning', 'vibeQuote'];
const MIN_LENGTH_FOR_AI_CHECK = 15;

const OPENAI_THRESHOLDS = {
  sexual:                    0.5,
  'sexual/minors':           0.05,
  harassment:                0.6,
  'harassment/threatening':  0.4,
  hate:                      0.5,
  'hate/threatening':        0.4,
  violence:                  0.75,
  'violence/graphic':        0.5,
  'self-harm':               0.4,
  'self-harm/intent':        0.2,
  'self-harm/instructions':  0.2,
};

// ── Layer 1: Normalization ────────────────────────────────────

const LEET_MAP = {
  '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i',
  '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't',
  '8': 'b', '6': 'g', '9': 'g',
};

function normalizeText(text) {
  let t = text.toLowerCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[@4310!5$78+69]/g, char => LEET_MAP[char] || char);
  // Collapse spaced-out chars: "w h a t s a p p" → "whatsapp"
  t = t.replace(/\b(\w)([\s.\-_]+\w){2,}/g, match => match.replace(/[\s.\-_]+/g, ''));
  t = t.replace(/(\w)[.\-_](\w)/g, '$1$2');
  return t;
}

// ── Layer 2A: Auto-clean patterns ────────────────────────────
// These patterns STRIP the offending content silently and save the rest.

const AUTO_CLEAN_PATTERNS = [
  // Indian mobile numbers: 9876543210, +91 98765 43210, 0091-9876543210
  /(?:(?:\+|00)?91[\s\-.]?)?[6-9]\d{9}/g,
  // Spaced-out numbers: "9 8 7 6 5 4 3 2 1 0"
  /\b[6-9](?:[\s.\-]{1,3}\d){9}\b/g,
  // Platform names
  /\b(whatsapp|whats\s*app|watsapp|wa\.me|telegram|t\.me|instagram|insta|snapchat|snap)\b/gi,
  // UPI / payment apps
  /\b(upi|paytm|gpay|google\s*pay|phonepe|bhim|@okaxis|@oksbi|@ybl|@paytm)\b/gi,
  // Currency with amounts: ₹500, $20
  /[₹$€£]\s*\d+/g,
  // Pricing language
  /\b\d+\s*(?:rs|inr|rupees?)\b/gi,
  /\bper\s*(?:hour|hr|day|session|meet|visit|call)\b/gi,
  /\b(?:rate|charge|fee|cost)s?\s*[:=]?\s*\d+/gi,
  // URLs and emails
  /https?:\/\/[^\s]*/gi,
  /www\.[^\s]*/gi,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi,
];

function autoCleanText(text) {
  let cleaned = text;
  for (const pattern of AUTO_CLEAN_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

// ── Layer 2B: Hard-block patterns ────────────────────────────
// These REJECT the submission entirely — no silent cleaning.

const HARD_BLOCK_ORIGINAL = [
  // Contact-sharing intent
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me)\b/i,
  /\b(reach\s*(me|out)|hit\s*me\s*up|ping\s*me|slide\s*in(to)?\s*(my|the))\b/i,
  /\b(my\s*(number|no\.?|num|contact|handle|id|profile)\s*(?:is|:))/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,
  // Solicitation
  /\b(paid\s*(service|meet|session|companion|friend)|escort|hookup|hook\s*up)\b/i,
  /\b(nsa|friends?\s*with\s*benefits|fwb|sugar\s*(daddy|mama|baby))\b/i,
  /\b(rate\s*card|available\s*for\s*(hire|booking)|book\s*me|hire\s*me)\b/i,
  /\bfor\s*sex\b/i,
  /\bsex\s*(meet|chat|friend|partner|service)\b/i,
  /\b(playboy|play\s*boy|gigolo|call\s*girl)\b/i,
  /\b(available\s*for\s*(sex|hookup|fun|friendship\s*with\s*benefits))\b/i,
  // Self-harm
  /\b(kill\s*(my)?self|want\s*to\s*die|end\s*(my\s*)?life|commit\s*suicide)\b/i,
];

const HARD_BLOCK_NORMALIZED = [
  /whatsapp/, /telegram/, /instagram/, /snapchat/,
  /[6-9]\d{9}/,   // 10-digit phone after space collapse
  /\b\d{10,}\b/,  // any 10+ digit number
  /playboy/, /gigolo/,
  /forsex/, /sexmeet/,
];

function runHardBlockChecks(originalText, normalizedText) {
  for (const pattern of HARD_BLOCK_ORIGINAL) {
    if (pattern.test(originalText)) {
      return {
        blocked: true,
        reason: 'solicitation_or_contact_sharing',
        message: "Please keep your profile about who you are — contact details and service offers aren't allowed.",
      };
    }
  }
  for (const pattern of HARD_BLOCK_NORMALIZED) {
    if (pattern.test(normalizedText)) {
      return {
        blocked: true,
        reason: 'bypass_attempt',
        message: "Please don't include contact handles, platform names, or phone numbers — even spaced out.",
      };
    }
  }
  return { blocked: false };
}

// ── Layer 3: OpenAI Moderation ───────────────────────────────

async function checkWithOpenAI(fieldTexts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') throw new Error('OPENAI_API_KEY not configured');
    console.warn('[MODERATION] OPENAI_API_KEY missing — skipping AI check (dev mode)');
    return { safe: true, flaggedCategories: [], allScores: {} };
  }

  // Combine all fields into ONE API call to save cost
  const combinedInput = Object.entries(fieldTexts)
    .map(([field, text]) => `[${field}]: ${text}`)
    .join('\n---\n');

  const response = await axios.post(
    'https://api.openai.com/v1/moderations',
    { input: combinedInput },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 6000,
    }
  );

  const result = response.data.results[0];
  const scores = result.category_scores;
  const flaggedCategories = [];

  for (const [category, threshold] of Object.entries(OPENAI_THRESHOLDS)) {
    if (scores[category] !== undefined && scores[category] >= threshold) {
      flaggedCategories.push(category);
    }
  }

  return { safe: flaggedCategories.length === 0, flaggedCategories, allScores: scores };
}

function getAIBlockMessage(flaggedCategories) {
  if (flaggedCategories.some(c => c.startsWith('sexual')))    return 'Please keep your profile appropriate for all audiences.';
  if (flaggedCategories.some(c => c.startsWith('hate')))      return 'Hateful or discriminatory language is not allowed in profiles.';
  if (flaggedCategories.some(c => c.startsWith('harassment')))return 'Please keep your profile friendly and welcoming to everyone.';
  if (flaggedCategories.some(c => c.startsWith('self-harm'))) return "This content isn't allowed. If you're struggling, please reach out to someone you trust.";
  if (flaggedCategories.some(c => c.startsWith('violence')))  return 'Violent content is not allowed in profiles.';
  return "This content doesn't meet our community guidelines. Please revise and try again.";
}

// ── Core Orchestrator ─────────────────────────────────────────
/**
 * Run full moderation pipeline on questionnaire text fields.
 * Returns { cleanedQuestionnaire, errors }
 *
 * cleanedQuestionnaire: full questionnaire object with text fields replaced by cleaned versions
 * errors: per-field array — if non-empty, caller must reject with 422
 */
async function moderateQuestionnaire(questionnaire) {
  const errors = [];
  const textsForAI = {};
  const cleanedValues = {}; // field → cleaned string

  for (const field of MODERATED_TEXT_FIELDS) {
    const rawValue = questionnaire[field];
    if (!rawValue || typeof rawValue !== 'string') continue;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;

    // Step 1: Normalize
    const normalizedText = normalizeText(trimmed);

    // Step 2: Hard-block check
    const hardBlock = runHardBlockChecks(trimmed, normalizedText);
    if (hardBlock.blocked) {
      errors.push({
        field,
        code: hardBlock.reason === 'bypass_attempt' ? 'BYPASS_DETECTED' : 'HARD_BLOCK',
        message: hardBlock.message,
      });
      continue;
    }

    // Step 3: Auto-clean (strips phone numbers, platforms, etc.)
    const cleanedText = autoCleanText(trimmed);
    cleanedValues[field] = cleanedText;

    // Step 4: Queue for OpenAI if long enough
    if (normalizedText.length >= MIN_LENGTH_FOR_AI_CHECK) {
      textsForAI[field] = normalizedText;
    }
  }

  // Step 5: Single batched OpenAI call for all surviving fields
  if (Object.keys(textsForAI).length > 0 && errors.length === 0) {
    try {
      const aiResult = await checkWithOpenAI(textsForAI);
      if (!aiResult.safe) {
        const message = getAIBlockMessage(aiResult.flaggedCategories);
        for (const field of Object.keys(textsForAI)) {
          delete cleanedValues[field];
          errors.push({ field, code: 'AI_FLAGGED', categories: aiResult.flaggedCategories, message });
        }
      }
    } catch (aiError) {
      // Fail-open: log but don't block user if OpenAI is down
      console.error('[MODERATION] OpenAI call failed:', aiError.message);
    }
  }

  // Merge cleaned values back into questionnaire
  const cleanedQuestionnaire = { ...questionnaire };
  for (const [field, cleanedValue] of Object.entries(cleanedValues)) {
    cleanedQuestionnaire[field] = cleanedValue;
  }

  return { cleanedQuestionnaire, errors };
}

// =============================================
// USER PROFILE ROUTES
// =============================================

// @route   PUT /api/users/me
// @desc    Update user profile (firstName, lastName, profilePhoto, questionnaire)
// @access  Private
router.put('/me', authenticate, async (req, res) => {
  try {
    const updates = req.body;
    const allowedUpdates = ['firstName', 'lastName', 'profilePhoto', 'questionnaire'];

    const filteredUpdates = {};
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) filteredUpdates[key] = updates[key];
    });

    // ── Moderate questionnaire text fields if present ──────────
    if (filteredUpdates.questionnaire && typeof filteredUpdates.questionnaire === 'object') {
      const { cleanedQuestionnaire, errors } = await moderateQuestionnaire(filteredUpdates.questionnaire);

      if (errors.length > 0) {
        return res.status(422).json({
          success: false,
          code: 'MODERATION_FAILED',
          message: "Some fields contain content that isn't allowed. Please review and update them.",
          errors,
        });
      }

      filteredUpdates.questionnaire = cleanedQuestionnaire;
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      filteredUpdates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, message: 'Profile updated successfully', user });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private
router.get('/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, user });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   DELETE /api/users/me
// @desc    Delete user account
// @access  Private
router.delete('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.profilePhotoPublicId)      await deleteImage(user.profilePhotoPublicId);
    if (user.verificationPhotoPublicId) await deleteImage(user.verificationPhotoPublicId);

    await User.findByIdAndDelete(req.userId);

    res.json({ success: true, message: 'Account deleted successfully' });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================
// LOCATION ROUTE
// =============================================

// @route   POST /api/users/location
// @desc    Update user's last known location
// @access  Private
router.post('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng, timestamp } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude are required' });
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'Invalid latitude or longitude values' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.updateLocation(lat, lng);
    await user.save();

    console.log(`📍 Location updated for user ${user._id}: (${lat}, ${lng})`);

    res.json({
      success: true,
      message: 'Location updated successfully',
      location: {
        last_known_lat: user.last_known_lat,
        last_known_lng: user.last_known_lng,
        last_location_updated_at: user.last_location_updated_at,
      },
    });

  } catch (error) {
    console.error('❌ Location update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating location' });
  }
});

// =============================================
// FCM TOKEN MANAGEMENT
// =============================================

// @route   POST /api/users/fcm-token
// @desc    Register FCM token for push notifications
// @access  Private
router.post('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ success: false, message: 'FCM token is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.fcmTokens) user.fcmTokens = [];

    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
      if (user.fcmTokens.length > 5) user.fcmTokens = user.fcmTokens.slice(-5);
      await user.save();
      console.log(`✅ FCM token registered for user ${user._id}`);
    }

    res.json({ success: true, message: 'FCM token registered successfully' });

  } catch (error) {
    console.error('❌ FCM token registration error:', error);
    res.status(500).json({ success: false, message: 'Failed to register FCM token' });
  }
});

// @route   DELETE /api/users/fcm-token
// @desc    Remove FCM token (for logout)
// @access  Private
router.delete('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ success: false, message: 'FCM token is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.fcmTokens) {
      user.fcmTokens = user.fcmTokens.filter(token => token !== fcmToken);
      await user.save();
    }

    res.json({ success: true, message: 'FCM token removed successfully' });

  } catch (error) {
    console.error('❌ FCM token removal error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove FCM token' });
  }
});

// =============================================
// PHOTO UPLOAD ROUTES
// =============================================

// @route   POST /api/users/upload-profile-photo
// @desc    Upload profile photo (multipart/form-data)
// @access  Private
router.post('/upload-profile-photo', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo uploaded' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.profilePhotoPublicId) await deleteImage(user.profilePhotoPublicId);

    const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/profiles');
    user.profilePhoto = uploadResult.url;
    user.profilePhotoPublicId = uploadResult.publicId;
    await user.save();

    res.json({ success: true, message: 'Profile photo uploaded successfully', profilePhoto: user.profilePhoto });

  } catch (error) {
    console.error('Upload profile photo error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading photo' });
  }
});

// @route   POST /api/users/upload-profile-photo-base64
// @desc    Upload profile photo as base64
// @access  Private
router.post('/upload-profile-photo-base64', authenticate, async (req, res) => {
  try {
    const { photoBase64 } = req.body;

    if (!photoBase64) {
      return res.status(400).json({ success: false, message: 'No photo data provided' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.profilePhotoPublicId) await deleteImage(user.profilePhotoPublicId);

    const uploadResult = await uploadBase64(photoBase64, 'humrah/profiles');
    user.profilePhoto = uploadResult.url;
    user.profilePhotoPublicId = uploadResult.publicId;
    await user.save();

    res.json({ success: true, message: 'Profile photo uploaded successfully', profilePhoto: user.profilePhoto });

  } catch (error) {
    console.error('Upload profile photo error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading photo' });
  }
});

// @route   POST /api/users/submit-verification-photo
// @desc    Submit photo for manual verification (multipart/form-data)
// @access  Private
router.post('/submit-verification-photo', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo uploaded' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.verificationPhotoPublicId) await deleteImage(user.verificationPhotoPublicId);

    const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/verification');
    user.verificationPhoto = uploadResult.url;
    user.verificationPhotoPublicId = uploadResult.publicId;
    user.verificationPhotoSubmittedAt = new Date();
    user.photoVerificationStatus = 'pending';
    await user.save();

    res.json({
      success: true,
      message: 'Verification photo submitted successfully. Our team will review it soon.',
      verificationPhoto: user.verificationPhoto,
      photoVerificationStatus: user.photoVerificationStatus,
    });

  } catch (error) {
    console.error('Submit verification photo error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/users/submit-verification-photo-base64
// @desc    Submit verification photo as base64
// @access  Private
router.post('/submit-verification-photo-base64', authenticate, async (req, res) => {
  try {
    const { photoBase64 } = req.body;

    if (!photoBase64) {
      return res.status(400).json({ success: false, message: 'No photo data provided' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.verificationPhotoPublicId) await deleteImage(user.verificationPhotoPublicId);

    const uploadResult = await uploadBase64(photoBase64, 'humrah/verification');
    user.verificationPhoto = uploadResult.url;
    user.verificationPhotoPublicId = uploadResult.publicId;
    user.verificationPhotoSubmittedAt = new Date();
    user.photoVerificationStatus = 'pending';
    await user.save();

    res.json({
      success: true,
      message: 'Verification photo submitted successfully. Our team will review it soon.',
      verificationPhoto: user.verificationPhoto,
      photoVerificationStatus: user.photoVerificationStatus,
    });

  } catch (error) {
    console.error('Submit verification photo error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================
// QUESTIONNAIRE ROUTE
// =============================================

// @route   PUT /api/users/me/questionnaire
// @desc    Merge & update questionnaire (multi-step onboarding + profile completion)
// @access  Private
//
// ⚠️ This is the PRIMARY route used by ProfileCompletionScreen.
//    Full moderation pipeline runs here before any save.
router.put('/me/questionnaire', authenticate, async (req, res) => {
  try {
    const { questionnaire } = req.body;

    if (!questionnaire || typeof questionnaire !== 'object') {
      return res.status(400).json({ success: false, message: 'Questionnaire data is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // ── Run moderation on incoming text fields ─────────────────
    const { cleanedQuestionnaire, errors } = await moderateQuestionnaire(questionnaire);

    if (errors.length > 0) {
      return res.status(422).json({
        success: false,
        code: 'MODERATION_FAILED',
        message: "Some fields contain content that isn't allowed. Please review and update them.",
        errors, // [{ field, code, message }] — display inline under the offending field in Android
      });
    }

    // ── Merge cleaned questionnaire (don't overwrite unrelated fields) ─
    user.questionnaire = {
      ...(user.questionnaire?.toObject?.() || user.questionnaire || {}),
      ...cleanedQuestionnaire,
    };

    user.markModified('questionnaire');
    await user.save();

    res.json({
      success: true,
      message: 'Questionnaire saved successfully',
      user,
    });

  } catch (error) {
    console.error('Save questionnaire error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================
// ADMIN ROUTES
// =============================================

// @route   PUT /api/users/:userId/verify-photo
// @desc    Admin: Approve or reject user's verification photo
// @access  Private (Admin only)
router.put(
  '/:userId/verify-photo',
  authenticate,
  adminOnly,
  auditLog('VERIFY_USER_PHOTO', 'USER'),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { approved } = req.body;

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      if (!user.verificationPhoto) {
        return res.status(400).json({ success: false, message: 'No verification photo to review' });
      }

      user.photoVerificationStatus = approved ? 'approved' : 'rejected';
      user.photoVerifiedAt = new Date();
      user.photoVerifiedBy = req.userId;
      user.verified = user.isFullyVerified();
      await user.save();

      res.json({
        success: true,
        message: `Photo verification ${approved ? 'approved' : 'rejected'} successfully`,
        user: {
          id: user._id,
          photoVerificationStatus: user.photoVerificationStatus,
          verified: user.verified,
          photoVerifiedAt: user.photoVerifiedAt,
        },
      });

    } catch (error) {
      console.error('Verify photo error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// @route   GET /api/users/admin/pending-verifications
// @desc    Admin: Get all users pending photo verification
// @access  Private (Admin only)
router.get('/admin/pending-verifications', authenticate, adminOnly, async (req, res) => {
  try {
    const users = await User.find({
      photoVerificationStatus: 'pending',
      verificationPhoto: { $ne: null },
    })
      .select('firstName lastName email verificationPhoto verificationPhotoSubmittedAt')
      .sort({ verificationPhotoSubmittedAt: -1 });

    res.json({ success: true, count: users.length, users });

  } catch (error) {
    console.error('Get pending verifications error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
