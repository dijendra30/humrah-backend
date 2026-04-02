// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant — logic-first, Groq only for wording polish.
//
// Architecture: User → UI → Backend Logic → (Optional Groq rewrite) → Response
//
// RULES:
//  1. NO direct AI decision-making.
//  2. All data goes through buildSafeProfileSummary() — allowed fields only.
//  3. Logic engine decides bullets. Groq only rewrites the final text.
//  4. Groq prompt: "Rewrite this in a friendly, short, and helpful tone: ${text}"
//  5. Groq never sees profile data — only the plain advice text.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const User    = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED FIELDS — the ONLY fields this route ever reads from the User document.
// Phone, email, chats, reports, exact location, and all internal fields are
// never touched. This list is also sent back to the client for transparency.
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_FIELDS = [
  'hasProfilePhoto',
  'bio',
  'preferences',
  'availability',
  'completionScore',
  'missingFields',
];

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Build a safe, minimal profile summary.
// Only ALLOWED_FIELDS values are derived here. Nothing else leaves this fn.
// ─────────────────────────────────────────────────────────────────────────────
function buildSafeProfileSummary(user) {
  const q = user.questionnaire || {};

  const hasProfilePhoto = !!user.profilePhoto;
  const bio             = (q.bio || '').trim();
  const preferences     = [
    ...(Array.isArray(q.hangoutPreferences) ? q.hangoutPreferences : []),
    ...(Array.isArray(q.interests)          ? q.interests          : []),
    ...(Array.isArray(q.comfortActivity)    ? q.comfortActivity    : []),
  ].filter(Boolean);
  const availability = Array.isArray(q.availableTimes) ? q.availableTimes : [];

  // Determine which of the 6 key items are missing
  const missingFields = [];
  if (!hasProfilePhoto)          missingFields.push('profilePhoto');
  if (bio.length < 10)           missingFields.push('bio');
  if (availability.length === 0) missingFields.push('availability');
  if (preferences.length < 2)   missingFields.push('preferences');
  if (!q.ageGroup)               missingFields.push('ageGroup');
  if (!q.city)                   missingFields.push('city');

  const totalItems      = 6;
  const completionScore = Math.round(((totalItems - missingFields.length) / totalItems) * 100);

  return { hasProfilePhoto, bio, preferences, availability, completionScore, missingFields };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Logic engine.
// Decides ALL content. Returns plain English bullets + a CTA label.
// AI is NOT called here. Pure deterministic logic.
// ─────────────────────────────────────────────────────────────────────────────
function runLogicEngine(intent, summary) {
  const { missingFields, completionScore, hasProfilePhoto, bio, preferences, availability } = summary;

  switch (intent) {

    // ── "Complete my profile" ─────────────────────────────────────────────
    case 'complete_profile': {
      if (missingFields.length === 0) {
        return {
          intro: `You're ${completionScore}% complete — your profile is all set!`,
          bullets: [
            'Refresh your bio every few weeks to stay relevant.',
            'Keep your availability up to date to get more bookings.',
          ],
          callToAction: null,
          completionScore,
        };
      }

      const bullets = missingFields.slice(0, 5).map(field => {
        switch (field) {
          case 'profilePhoto': return 'Add a profile photo — profiles with photos get 3x more views.';
          case 'bio':          return 'Add a bio (at least 10 characters) so others know who you are.';
          case 'availability': return 'Set your available time slots so people know when you can meet.';
          case 'preferences':  return 'Add at least 2 interests or hangout preferences.';
          case 'ageGroup':     return 'Set your age group for better match suggestions.';
          case 'city':         return 'Add your city so nearby users can discover you.';
          default:             return `Fill in your ${field}.`;
        }
      });

      return {
        intro: `You're ${completionScore}% complete.`,
        bullets,
        callToAction: 'Fix Now',
        completionScore,
      };
    }

    // ── "Improve my profile" ──────────────────────────────────────────────
    case 'improve_profile': {
      const tips = [];

      if (!hasProfilePhoto) {
        tips.push('Add a real, well-lit profile photo — it is the first thing people notice.');
      } else {
        tips.push('Your photo looks good. Make sure it is recent and clearly shows your face.');
      }

      if (bio.length < 10) {
        tips.push('Write a bio with 2 to 3 sentences. Share what you enjoy and what kind of meetup you are open to.');
      } else if (bio.length < 60) {
        tips.push('Your bio is short. Add more personality — mention a hobby or your favourite activity.');
      } else {
        tips.push('Your bio is solid. Keep it authentic and update it when your interests change.');
      }

      if (availability.length === 0) {
        tips.push('Set your availability so people know when to reach out to you.');
      } else {
        tips.push('Good — you have availability set. Update it whenever your schedule changes.');
      }

      if (preferences.length < 2) {
        tips.push('Add at least 2 interests to improve your discovery ranking.');
      } else if (preferences.length < 5) {
        tips.push('Add a few more interests — more context helps people find common ground with you.');
      } else {
        tips.push('Great range of interests! Keep them current.');
      }

      return {
        intro: null,
        bullets: tips.slice(0, 5),
        callToAction: 'Edit Profile',
        completionScore,
      };
    }

    // ── "Why am I not getting bookings?" ─────────────────────────────────
    case 'booking_help': {
      const reasons = [];

      if (!hasProfilePhoto)    reasons.push('No profile photo — this is the number one reason people skip a profile.');
      if (bio.length < 10)     reasons.push('Your bio is missing or too short. People want to know who they are meeting.');
      if (availability.length === 0) reasons.push('No availability set — people cannot see when you are free to meet.');
      if (preferences.length < 2)   reasons.push('Too few interests listed — add more so the system can match you with the right people.');

      if (reasons.length === 0) {
        return {
          intro: 'Your profile looks complete! Here are a few tips to boost bookings:',
          bullets: [
            'Stay active — log in regularly so your profile appears at the top.',
            'Update your availability often so people know you are reachable.',
            'Refresh your bio occasionally to keep it feeling current.',
          ],
          callToAction: null,
          completionScore,
        };
      }

      return {
        intro: 'Here are the likely reasons you are not getting bookings:',
        bullets: reasons.slice(0, 5),
        callToAction: 'Fix Issues',
        completionScore,
      };
    }

    // ── Fallback — unclear input → show options again (per spec) ──────────
    default:
      return {
        intro: null,
        bullets: ['Please choose one of the options to get started.'],
        callToAction: null,
        completionScore,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Optional Groq polish.
//
// Spec-exact prompt per bullet:
//   "Rewrite this in a friendly, short, and helpful tone: ${bullet}"
//
// Groq receives ONLY the plain advice text — no user data whatsoever.
// If GROQ_API_KEY is absent, times out, or returns bad output, the original
// logic-engine bullet is used unchanged. Groq never makes decisions.
// ─────────────────────────────────────────────────────────────────────────────
async function polishWithGroq(bullets) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return bullets; // Groq is optional — skip if not configured

  const polished = [];

  for (const bullet of bullets) {
    try {
      // ── Spec-exact Groq prompt ────────────────────────────────────────
      const prompt = `Rewrite this in a friendly, short, and helpful tone: ${bullet}`;

      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama3-8b-8192',
          messages: [
            {
              role: 'system',
              content:
                'You are a helpful writing assistant. Rewrite the given sentence in a warm, concise, ' +
                'actionable tone. Return ONLY the rewritten sentence — no preamble, no explanation, no quotes.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 80,
          temperature: 0.5,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 4000, // tight timeout so the overall response stays fast
        }
      );

      const rewritten = res.data?.choices?.[0]?.message?.content?.trim();
      // Only use Groq output if non-empty and not absurdly long
      polished.push(rewritten && rewritten.length > 0 && rewritten.length < 200
        ? rewritten
        : bullet
      );
    } catch {
      polished.push(bullet); // Groq failed for this bullet — keep original
    }
  }

  return polished;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/profile-assistant/consent ──────────────────────────────────────
// Stores profileBotConsent = true for the authenticated user.
router.post('/consent', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.profileBotConsent = true;
    await user.save();

    res.json({ success: true, message: 'Access granted. The assistant can now help you.' });
  } catch (err) {
    console.error('[ProfileAssistant] consent error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/profile-assistant/analyze ──────────────────────────────────────
// Body: { intent: 'improve_profile' | 'booking_help' | 'complete_profile' }
router.post('/analyze', auth, async (req, res) => {
  try {
    const { intent } = req.body;

    const validIntents = ['improve_profile', 'booking_help', 'complete_profile'];

    // Fallback per spec: invalid/unclear intent → tell user to pick an option
    if (!intent || !validIntents.includes(intent)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_INTENT',
        message: 'Please choose one of the options to get started.',
      });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // ── Consent gate (spec: show "Allow Access" if not consented) ────────
    if (!user.profileBotConsent) {
      return res.status(403).json({
        success: false,
        code: 'CONSENT_REQUIRED',
        message: 'We need access to your profile data to help you better.',
      });
    }

    // ── STEP 1: Build safe summary — only ALLOWED_FIELDS ─────────────────
    const summary = buildSafeProfileSummary(user);

    // ── STEP 2: Logic engine decides everything ───────────────────────────
    const { intro, bullets, callToAction, completionScore } = runLogicEngine(intent, summary);

    // ── STEP 3: Optional Groq polish — only rewrites, never decides ───────
    const polishedBullets = await polishWithGroq(bullets);

    // ── Return safe response ──────────────────────────────────────────────
    return res.json({
      success: true,
      intent,
      completionScore,
      intro,
      bullets: polishedBullets,
      callToAction,
      allowedFields: ALLOWED_FIELDS, // transparent: tell client exactly what was read
    });

  } catch (err) {
    console.error('[ProfileAssistant] analyze error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
