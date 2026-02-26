// routes/profile.js - Profile Viewing and Editing Routes
// Moderation system integrated inline (no external middleware files needed)

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const ProfileEditLog = require('../models/ProfileEditLog');
const Review = require('../models/Review');

// =============================================
// MODERATION CONSTANTS
// =============================================

/**
 * Only these 3 fields go through the full moderation pipeline.
 * All other questionnaire fields (ageGroup, comfortZones, etc.)
 * are option-based and don't need text moderation.
 */
const MODERATED_TEXT_FIELDS = ['bio', 'goodMeetupMeaning', 'vibeQuote'];

/**
 * Minimum character count to bother calling OpenAI.
 * Very short strings are safe or already caught by regex.
 * Saves API cost on inputs like "chill" or "nice".
 */
const MIN_LENGTH_FOR_AI_CHECK = 15;

/**
 * OpenAI moderation category thresholds.
 * Scores above these values will block the submission.
 * Tune these based on observed false-positive rates.
 */
const OPENAI_THRESHOLDS = {
  sexual:                    0.5,
  'sexual/minors':           0.05,  // near-zero tolerance
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

// =============================================
// LAYER 1 — TEXT NORMALIZATION
// Collapses bypass attempts before regex runs.
// =============================================

const LEET_MAP = {
  '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i',
  '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't',
  '8': 'b', '6': 'g', '9': 'g',
};

/**
 * Normalize text to defeat common bypass techniques:
 * "w h a t s a p p" → "whatsapp"
 * "wh@ts@pp"        → "whatsapp"
 * "9 8 7 6 5 4 3 2 1 0" → "9876543210"
 */
function normalizeText(text) {
  let t = text.toLowerCase();

  // Remove diacritics: é → e, ñ → n
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Fullwidth unicode → ASCII: ａ → a
  t = t.replace(/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

  // Leet speak substitution
  t = t.replace(/[@4310!5$78+69]/g, char => LEET_MAP[char] || char);

  // Collapse spaced-out single characters: "w h a t s" → "whats"
  // Handles spaces, dots, dashes, underscores between single chars
  t = t.replace(/\b(\w)([\s.\-_]+\w){2,}/g, match => match.replace(/[\s.\-_]+/g, ''));

  // Remove remaining isolated separators between word characters
  t = t.replace(/(\w)[.\-_](\w)/g, '$1$2');

  return t;
}

// =============================================
// LAYER 2A — AUTO-CLEAN PATTERNS
// Strip the offending content, keep the rest of the text.
// Applied to the ORIGINAL text before saving.
// =============================================

const AUTO_CLEAN_PATTERNS = [
  // Indian mobile: 9876543210, +91 98765 43210, 0091-9876543210
  /(?:(?:\+|00)?91[\s\-.]?)?[6-9]\d{9}/g,

  // Spaced-out 10-digit numbers: "9 8 7 6 5 4 3 2 1 0", "9.8.7.6.5.4.3.2.1.0"
  /\b[6-9](?:[\s.\-]{1,3}\d){9}\b/g,

  // Platform names
  /\b(whatsapp|whats\s*app|watsapp|wa\.me|telegram|t\.me|instagram|insta|snapchat|snap)\b/gi,

  // UPI / payment apps
  /\b(upi|paytm|gpay|google\s*pay|phonepe|bhim|@okaxis|@oksbi|@ybl|@paytm)\b/gi,

  // Currency with amounts: ₹500, $20
  /[₹$€£]\s*\d+/g,

  // Pricing language: 500 rs, per hour, per session, rate: 500
  /\b\d+\s*(?:rs|inr|rupees?)\b/gi,
  /\bper\s*(?:hour|hr|day|session|meet|visit|call)\b/gi,
  /\b(?:rate|charge|fee|cost)s?\s*[:=]?\s*\d+/gi,

  // URLs (http, www)
  /https?:\/\/[^\s]*/gi,
  /www\.[^\s]*/gi,

  // Email addresses
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi,
];

/**
 * Strip auto-clean patterns from original text.
 * Returns cleaned text with extra whitespace collapsed.
 */
function autoCleanText(originalText) {
  let cleaned = originalText;
  for (const pattern of AUTO_CLEAN_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

// =============================================
// LAYER 2B — HARD-BLOCK PATTERNS
// Reject entire submission — no auto-cleaning.
// Checked on ORIGINAL text first, then NORMALIZED.
// =============================================

// Checked on original text
const HARD_BLOCK_ORIGINAL = [
  // Explicit contact-sharing intent
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me)\b/i,
  /\b(reach\s*(me|out)|hit\s*me\s*up|ping\s*me|slide\s*in(to)?\s*(my|the))\b/i,
  /\b(my\s*(number|no\.?|num|contact|handle|id|profile)\s*(?:is|:))/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,

  // Solicitation
  /\b(paid\s*(service|meet|session|companion|friend)|escort|hookup|hook\s*up)\b/i,
  /\b(nsa|friends?\s*with\s*benefits|fwb|sugar\s*(daddy|mama|baby))\b/i,
  /\b(rate\s*card|available\s*for\s*(hire|booking)|book\s*me|hire\s*me)\b/i,

  // Self-harm (direct text)
  /\b(kill\s*(my)?self|want\s*to\s*die|end\s*(my\s*)?life|commit\s*suicide)\b/i,
];

// Checked on normalized (leet-collapsed) text
const HARD_BLOCK_NORMALIZED = [
  // Catch bypass variants of platform names after normalization
  /whatsapp/,
  /telegram/,
  /instagram/,
  /snapchat/,
  // 10 consecutive digits starting with 6-9 (phone number after collapse)
  /[6-9]\d{9}/,
  // Spaced digits that survived as a run after normalization
  /\b\d{10,}\b/,
];

/**
 * Returns { blocked: true, reason, message } or { blocked: false }
 */
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

// =============================================
// LAYER 3 — OPENAI MODERATION API
// Called only if layers 1+2 pass, and text >= MIN_LENGTH.
// All 3 fields are combined into ONE API call to minimize cost.
// =============================================

/**
 * Calls OpenAI moderation on combined text of all 3 fields.
 * Returns { safe, flaggedFields, allScores }
 *
 * Security: API key is only ever read from process.env on the server.
 * It is never exposed to clients.
 */
async function checkWithOpenAI(fieldTexts) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      // In production, throw so the request is handled safely
      throw new Error('OPENAI_API_KEY is not configured on server');
    }
    // In dev, skip silently with a warning
    console.warn('[MODERATION] OPENAI_API_KEY missing — skipping AI check (dev mode)');
    return { safe: true, flaggedFields: [], allScores: {} };
  }

  // Combine all fields into one input with separators
  // This costs 1 API call instead of 3 — major cost saving
  const combinedInput = Object.entries(fieldTexts)
    .map(([field, text]) => `[${field}]: ${text}`)
    .join('\n---\n');

  const response = await axios.post(
    'https://api.openai.com/v1/moderations',
    { input: combinedInput },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 6000, // 6s — don't block user on slow API
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

  return {
    safe: flaggedCategories.length === 0,
    flaggedCategories,
    openAiFlagged: result.flagged,
    allScores: scores,
  };
}

/**
 * Maps flagged OpenAI categories to a human-readable message for the user.
 */
function getAIBlockMessage(flaggedCategories) {
  if (flaggedCategories.some(c => c.startsWith('sexual')))
    return 'Please keep your profile appropriate for all audiences.';
  if (flaggedCategories.some(c => c.startsWith('hate')))
    return 'Hateful or discriminatory language is not allowed in profiles.';
  if (flaggedCategories.some(c => c.startsWith('harassment')))
    return 'Please keep your profile friendly and welcoming to everyone.';
  if (flaggedCategories.some(c => c.startsWith('self-harm')))
    return "This content isn't allowed. If you're struggling, please reach out to someone you trust.";
  if (flaggedCategories.some(c => c.startsWith('violence')))
    return 'Violent content is not allowed in profiles.';
  return "This content doesn't meet our community guidelines. Please revise and try again.";
}

// =============================================
// CORE MODERATION ORCHESTRATOR
// Runs all layers for a given set of field values.
// Returns { cleanedFields, errors }
// =============================================

/**
 * @param {Object} questionnaire - raw questionnaire object from req.body
 * @returns {{ cleanedFields: Object, errors: Array }}
 *
 * cleanedFields: object with safe, cleaned values (only MODERATED_TEXT_FIELDS)
 * errors: per-field array for structured 422 response
 */
async function runModerationPipeline(questionnaire) {
  const cleanedFields = {};
  const errors = [];

  // Collect texts that survived regex layers (for single batched OpenAI call)
  const textsForAI = {};

  for (const field of MODERATED_TEXT_FIELDS) {
    const rawValue = questionnaire[field];

    // Skip empty / unchanged / non-string values — caller handles those
    if (!rawValue || typeof rawValue !== 'string') continue;
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) continue;

    // ── STEP 1: Normalize ──────────────────────────────────────
    const normalizedText = normalizeText(trimmed);

    // ── STEP 2: Hard-block check ───────────────────────────────
    const hardBlock = runHardBlockChecks(trimmed, normalizedText);
    if (hardBlock.blocked) {
      errors.push({
        field,
        code: hardBlock.reason === 'bypass_attempt' ? 'BYPASS_DETECTED' : 'HARD_BLOCK',
        message: hardBlock.message,
      });
      continue; // don't process further for this field
    }

    // ── STEP 3: Auto-clean (strip phone numbers, platform refs, etc.) ──
    const cleanedText = autoCleanText(trimmed);

    // ── STEP 4: Queue for OpenAI check if long enough ──────────
    if (normalizedText.length >= MIN_LENGTH_FOR_AI_CHECK) {
      textsForAI[field] = normalizedText; // check normalized, save cleaned
    }

    // Tentatively mark as clean (OpenAI may still block it below)
    cleanedFields[field] = cleanedText;
  }

  // ── STEP 5: Single batched OpenAI call for all surviving fields ──
  if (Object.keys(textsForAI).length > 0) {
    try {
      const aiResult = await checkWithOpenAI(textsForAI);

      if (!aiResult.safe) {
        // OpenAI flagged the combined content — we attribute the error
        // to each field that was in the AI batch (conservative approach)
        const message = getAIBlockMessage(aiResult.flaggedCategories);
        for (const field of Object.keys(textsForAI)) {
          // Remove from cleanedFields since it's flagged
          delete cleanedFields[field];
          errors.push({
            field,
            code: 'AI_FLAGGED',
            categories: aiResult.flaggedCategories,
            message,
          });
        }
      }
    } catch (aiError) {
      // Log the failure but DON'T block the user (fail-open for API downtime)
      // Swap to fail-closed by pushing to errors[] if you prefer strict safety
      console.error('[MODERATION] OpenAI API call failed:', aiError.message);
    }
  }

  return { cleanedFields, errors };
}

// =============================================
// ROUTES
// =============================================

// @route   GET /api/profile/:userId
// @desc    Get public profile view for any user
// @access  Private (authenticated users only)
router.get('/:userId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);

    if (!user || user.deletedAt) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, profile: user.getPublicProfile() });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/profile/me/private
// @desc    Get full profile for logged-in user (including private data)
// @access  Private
router.get('/me/private', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const privateProfile = user.getPrivateProfile();

    const editableFields = {};
    const fields = ['profilePhoto', 'bio', 'ageGroup', 'state', 'area', 'price', 'tagline'];
    for (const field of fields) {
      editableFields[field] = await ProfileEditLog.checkRateLimit(req.userId, field);
    }

    res.json({ success: true, profile: privateProfile, editableFields });

  } catch (error) {
    console.error('Get private profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/profile/me
// @desc    Update profile fields (with full moderation for text fields)
// @access  Private
router.put('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const updates = req.body.questionnaire || {};

    // ── STEP A: Run moderation pipeline on text fields ─────────
    // Isolate only the text fields that need moderation from the update payload
    const textFieldUpdates = {};
    for (const field of MODERATED_TEXT_FIELDS) {
      if (updates[field] !== undefined) {
        textFieldUpdates[field] = updates[field];
      }
    }

    if (Object.keys(textFieldUpdates).length > 0) {
      const { cleanedFields, errors } = await runModerationPipeline(textFieldUpdates);

      // If any text field was rejected, return immediately with structured errors
      if (errors.length > 0) {
        return res.status(422).json({
          success: false,
          code: 'MODERATION_FAILED',
          message: "Some fields contain content that isn't allowed. Please review and update them.",
          errors, // array of { field, code, message } — ready for inline display in Android
        });
      }

      // Replace original text values with cleaned versions
      for (const [field, cleanedValue] of Object.entries(cleanedFields)) {
        updates[field] = cleanedValue;
      }
    }

    // ── STEP B: Process all fields (moderated text + non-text option fields) ──
    const updatedFields = [];
    const rateLimitErrors = [];

    for (const [field, newValue] of Object.entries(updates)) {
      // Skip if value hasn't changed
      const oldValue = user.questionnaire?.[field];
      if (oldValue === newValue) continue;

      // Rate limit check
      const rateLimit = await ProfileEditLog.checkRateLimit(req.userId, field);
      if (!rateLimit.allowed) {
        rateLimitErrors.push({ field, message: rateLimit.reason, resetAt: rateLimit.resetAt });
        continue;
      }

      // Length validation (belt-and-suspenders after moderation)
      if (field === 'bio' && newValue && newValue.length > 150) {
        return res.status(400).json({ success: false, message: 'Bio must be 150 characters or less' });
      }
      if (field === 'tagline' && newValue && newValue.length > 30) {
        return res.status(400).json({ success: false, message: 'Tagline must be 30 characters or less' });
      }

      // Apply update
      if (!user.questionnaire) user.questionnaire = {};
      user.questionnaire[field] = newValue;

      // Log edit
      await ProfileEditLog.logEdit(req.userId, field, oldValue, newValue, {
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      // Update edit stats
      if (field === 'bio') user.profileEditStats.lastBioUpdate = new Date();
      if (field === 'ageGroup') user.profileEditStats.lastAgeGroupUpdate = new Date();
      user.profileEditStats.totalEdits += 1;

      updatedFields.push(field);
    }

    // Save (markModified needed for nested Mongoose objects)
    if (updatedFields.length > 0) {
      user.markModified('questionnaire');
      await user.save();
    }

    // Rate limit errors on non-text fields
    if (rateLimitErrors.length > 0) {
      return res.status(429).json({
        success: false,
        message: 'Some fields could not be updated due to rate limits',
        updatedFields,
        rateLimitErrors,
      });
    }

    res.json({ success: true, message: 'Profile updated successfully', updatedFields });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/profile/me/edit-history
// @desc    Get user's own edit history
// @access  Private
router.get('/me/edit-history', auth, async (req, res) => {
  try {
    const { days = 30, page = 1, limit = 20 } = req.query;

    const history = await ProfileEditLog.getUserEditHistory(req.userId, {
      days: parseInt(days),
      page: parseInt(page),
      limit: parseInt(limit),
    });

    res.json({ success: true, history });

  } catch (error) {
    console.error('Get edit history error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/profile/me/delete
// @desc    Delete user account (soft delete)
// @access  Private
router.post('/me/delete', auth, async (req, res) => {
  try {
    const { reason, confirmPendingPayoutForfeit } = req.body;

    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.paymentInfo && user.paymentInfo.pendingPayout > 0) {
      if (!confirmPendingPayoutForfeit) {
        return res.status(400).json({
          success: false,
          message: 'You have pending payouts. Please confirm forfeit or withdraw first.',
          pendingAmount: user.paymentInfo.pendingPayout,
        });
      }
    }

    await user.softDelete(reason || 'User requested deletion');

    res.json({ success: true, message: 'Account deleted successfully' });

  } catch (error) {
    if (error.message.includes('active bookings') || error.message.includes('pending payouts')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('Delete account error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
