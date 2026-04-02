// routes/profileAssistant.js
// Profile Assistant — logic-first, Groq only for wording polish.
// NO direct AI decision-making. NO sensitive data sent to Groq.

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const User    = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED FIELDS — the only fields the backend will ever expose to this route
// Phone, email, chats, location, and all internal fields are never included.
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_PROFILE_FIELDS = [
  'hasProfilePhoto',
  'bio',
  'preferences',       // derived from questionnaire.hangoutPreferences / interests
  'availability',      // questionnaire.availableTimes
  'completionScore',
  'missingFields',
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive safe profile summary from User document.
 * Returns ONLY the allowed fields — nothing else leaves this function.
 */
function buildSafeProfileSummary(user) {
  const q = user.questionnaire || {};

  const hasProfilePhoto = !!user.profilePhoto;

  const bio            = q.bio || '';
  const preferences    = [
    ...(q.hangoutPreferences || []),
    ...(q.interests || []),
    ...(q.comfortActivity || []),
  ];
  const availability   = q.availableTimes || [];

  // Compute missing fields
  const missingFields = [];
  if (!hasProfilePhoto)           missingFields.push('profilePhoto');
  if (!bio || bio.trim().length < 10) missingFields.push('bio');
  if (availability.length === 0)  missingFields.push('availability');
  if (preferences.length < 2)     missingFields.push('preferences');
  if (!q.ageGroup)                missingFields.push('ageGroup');
  if (!q.city)                    missingFields.push('city');

  // Score: 6 possible items
  const totalItems = 6;
  const completedItems = totalItems - missingFields.length;
  const completionScore = Math.round((completedItems / totalItems) * 100);

  return {
    hasProfilePhoto,
    bio,
    preferences,
    availability,
    completionScore,
    missingFields,
  };
}

/**
 * Pure logic engine — decides what advice to give.
 * Returns { bullets: string[], callToAction: string }
 * AI is NOT called here. Only strings are produced.
 */
function runLogicEngine(intent, profileSummary) {
  const { missingFields, completionScore, hasProfilePhoto, bio, preferences, availability } = profileSummary;

  switch (intent) {

    // ── "Complete my profile" ──────────────────────────────────────────────
    case 'complete_profile': {
      if (missingFields.length === 0) {
        return {
          bullets: [
            'Your profile is 100% complete — great job!',
            'Consider refreshing your bio every few weeks to stay relevant.',
            'Updating your availability regularly boosts your visibility.',
          ],
          callToAction: null,
        };
      }
      const bullets = missingFields.map(field => {
        switch (field) {
          case 'profilePhoto': return 'Add a clear profile photo — profiles with photos get 3× more views.';
          case 'bio':          return 'Write a short bio (at least 10 characters) so others know who you are.';
          case 'availability': return 'Set your available times so people know when you can meet.';
          case 'preferences':  return 'Add at least 2 interests or hangout preferences.';
          case 'ageGroup':     return 'Set your age group — it helps with better match suggestions.';
          case 'city':         return 'Add your city so nearby people can discover you.';
          default:             return `Fill in your ${field}.`;
        }
      });
      return {
        bullets,
        callToAction: 'Fix Now',
        completionScore,
      };
    }

    // ── "Improve my profile" ──────────────────────────────────────────────
    case 'improve_profile': {
      const tips = [];

      if (!hasProfilePhoto) {
        tips.push('Upload a real, well-lit profile photo. It is the first thing people see.');
      } else {
        tips.push('Your photo looks good! Make sure it is recent and clearly shows your face.');
      }

      if (!bio || bio.trim().length < 20) {
        tips.push('Write a bio with 2–3 sentences. Share what you enjoy and what kind of meetup you are open to.');
      } else if (bio.trim().length < 60) {
        tips.push('Your bio is short. Add a bit more personality — mention a hobby or a favourite activity.');
      } else {
        tips.push('Your bio is solid. Keep it authentic and update it if your interests change.');
      }

      if (availability.length === 0) {
        tips.push('Set your availability so people know when to reach out.');
      } else {
        tips.push('Good — you have availability set. Update it whenever your schedule changes.');
      }

      if (preferences.length < 2) {
        tips.push('Add at least 2 interests or activity preferences to improve your discovery ranking.');
      } else if (preferences.length < 5) {
        tips.push('Try adding a few more interests — more context helps people find common ground with you.');
      }

      return {
        bullets: tips.slice(0, 4),
        callToAction: 'Edit Profile',
      };
    }

    // ── "Why am I not getting bookings?" ─────────────────────────────────
    case 'booking_help': {
      const reasons = [];

      if (!hasProfilePhoto) {
        reasons.push('No profile photo — this is the biggest reason people skip a profile.');
      }
      if (!bio || bio.trim().length < 20) {
        reasons.push('Your bio is too short or missing. People want to know who they are meeting.');
      }
      if (availability.length === 0) {
        reasons.push('No availability set — people cannot see when you are free to meet.');
      }
      if (preferences.length < 2) {
        reasons.push('Too few interests listed — add more so the system can match you better.');
      }

      if (reasons.length === 0) {
        reasons.push('Your profile looks complete! Bookings may take a little time — stay active and update your availability regularly.');
        reasons.push('Make sure your city is correct so people nearby can find you.');
        reasons.push('Try refreshing your bio to stay at the top of recent updates.');
      }

      return {
        bullets: reasons,
        callToAction: reasons.length > 0 ? 'Fix Issues' : null,
      };
    }

    default:
      return {
        bullets: ['Please choose one of the options to get started.'],
        callToAction: null,
      };
  }
}

/**
 * Optional Groq polish — rewrites bullet points in a friendlier tone.
 * If GROQ_API_KEY is missing or call fails, returns original bullets unchanged.
 * Groq NEVER receives profile data — only the plain advice text.
 */
async function polishWithGroq(bullets) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return bullets; // skip silently

  const rawText = bullets.map((b, i) => `${i + 1}. ${b}`).join('\n');
  const prompt  = `Rewrite each numbered bullet point below in a friendly, short, and helpful tone. 
Keep each point concise (max 15 words). Return ONLY the numbered list, no extra text.

${rawText}`;

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama3-8b-8192',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.5,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    const content = res.data?.choices?.[0]?.message?.content || '';
    // Parse numbered list back into array
    const parsed = content
      .split('\n')
      .filter(l => /^\d+\./.test(l.trim()))
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);

    // Safety: if Groq returns wrong count, fall back to originals
    return parsed.length === bullets.length ? parsed : bullets;
  } catch {
    return bullets; // fail silently — original logic response is used
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// @route  POST /api/profile-assistant/consent
// @desc   Grant consent to allow assistant to read safe profile fields
// @access Private
router.post('/consent', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.profileBotConsent = true;
    user.markModified('profileBotConsent');
    await user.save();

    res.json({ success: true, message: 'Consent granted. The assistant can now help you.' });
  } catch (err) {
    console.error('Profile assistant consent error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route  POST /api/profile-assistant/analyze
// @desc   Return safe, logic-driven profile advice
// @body   { intent: 'improve_profile' | 'booking_help' | 'complete_profile' }
// @access Private
router.post('/analyze', auth, async (req, res) => {
  try {
    const { intent } = req.body;

    const validIntents = ['improve_profile', 'booking_help', 'complete_profile'];
    if (!intent || !validIntents.includes(intent)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid intent. Must be one of: improve_profile, booking_help, complete_profile',
      });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // ── Consent gate ──────────────────────────────────────────────────────
    if (!user.profileBotConsent) {
      return res.status(403).json({
        success: false,
        code: 'CONSENT_REQUIRED',
        message: 'We need access to your profile data to help you better.',
      });
    }

    // ── Build safe summary (allowed fields only) ──────────────────────────
    const profileSummary = buildSafeProfileSummary(user);

    // ── Run logic engine ──────────────────────────────────────────────────
    const { bullets, callToAction, completionScore } = runLogicEngine(intent, profileSummary);

    // ── Optional Groq polish (non-blocking) ───────────────────────────────
    const polishedBullets = await polishWithGroq(bullets);

    // ── Return response (safe fields only) ───────────────────────────────
    return res.json({
      success: true,
      intent,
      completionScore: completionScore ?? profileSummary.completionScore,
      bullets: polishedBullets,
      callToAction,
      allowedFields: ALLOWED_PROFILE_FIELDS, // transparent: tell client what we read
    });

  } catch (err) {
    console.error('Profile assistant analyze error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
