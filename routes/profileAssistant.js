// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant — hybrid chat backend.
//
// Architecture:
//   User → Chat UI → Intent Check → Logic Engine → (Optional Groq) → Response
//
// Two endpoints:
//   POST /consent    — stores profileBotConsent = true
//   POST /analyze    — button clicks → LOGIC ONLY, never Groq
//   POST /chat       — typed messages → intent match → LOGIC, else Groq fallback
//
// RULES:
//   1. AI has NO direct DB access. All data goes through buildSafeProfileSummary().
//   2. Logic engine decides everything for button-triggered intents.
//   3. Groq only used when typed input doesn't match any known intent.
//   4. Groq receives filtered profile data + user message — never raw DB fields.
//   5. Max 5 Groq calls per user per day (tracked in-memory, resets at midnight).
//   6. After 2–3 AI replies in a session, show options again.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const User    = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED FIELDS — only these are ever read from the User document.
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
// GROQ DAILY RATE LIMITER
// In-memory map: userId → { date: 'YYYY-MM-DD', count: N }
// Resets automatically when the date changes.
// For production you can swap this for a Redis key with TTL=86400.
// ─────────────────────────────────────────────────────────────────────────────
const GROQ_DAILY_LIMIT  = 5;
const groqDailyUsage    = new Map(); // userId → { date, count }

function getTodayStr() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function groqCallsToday(userId) {
  const entry = groqDailyUsage.get(userId);
  const today = getTodayStr();
  if (!entry || entry.date !== today) return 0;
  return entry.count;
}

function incrementGroqUsage(userId) {
  const today = getTodayStr();
  const entry = groqDailyUsage.get(userId);
  if (!entry || entry.date !== today) {
    groqDailyUsage.set(userId, { date: today, count: 1 });
  } else {
    entry.count += 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Build safe profile summary (ALLOWED_FIELDS only).
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
// STEP 2a — Keyword-based intent matcher for typed messages.
// Returns: 'improve_profile' | 'booking_help' | 'complete_profile' | null
// ─────────────────────────────────────────────────────────────────────────────
function matchIntent(message) {
  const lower = message.toLowerCase().trim();

  // booking / no bookings
  if (/\b(booking|bookings|not getting|no booking|no one book|why.{0,20}book)\b/.test(lower)) {
    return 'booking_help';
  }

  // complete / missing / incomplete / fill
  if (/\b(complet|missing|fill|incomplete|finish|setup|set up)\b/.test(lower)) {
    return 'complete_profile';
  }

  // improve / better / tips / help / profile
  if (/\b(improv|better|tips|help|profile|enhance|update|how to|what should)\b/.test(lower)) {
    return 'improve_profile';
  }

  return null; // no match → Groq fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2b — Logic engine (button clicks and matched typed intents).
// All decisions made here. AI not involved.
// ─────────────────────────────────────────────────────────────────────────────
function runLogicEngine(intent, summary) {
  const { missingFields, completionScore, hasProfilePhoto, bio, preferences, availability } = summary;

  switch (intent) {

    case 'complete_profile': {
      if (missingFields.length === 0) {
        return {
          intro: `You're ${completionScore}% complete — your profile is all set! 🎉`,
          bullets: [
            'Refresh your bio every few weeks to stay relevant.',
            'Keep your availability updated to attract more bookings.',
          ],
          callToAction: null,
          completionScore,
          showOptionsAfter: true,
        };
      }
      const bullets = missingFields.slice(0, 5).map(field => {
        switch (field) {
          case 'profilePhoto': return 'Add a profile photo — profiles with photos get 3× more views.';
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
        showOptionsAfter: false,
      };
    }

    case 'improve_profile': {
      const tips = [];
      if (!hasProfilePhoto) {
        tips.push('Add a real, well-lit profile photo — it is the first thing people notice.');
      } else {
        tips.push('Your photo looks good. Make sure it is recent and clearly shows your face.');
      }
      if (bio.length < 10) {
        tips.push('Write a 2–3 sentence bio. Share what you enjoy and what kind of meetup you are open to.');
      } else if (bio.length < 60) {
        tips.push('Your bio is a bit short. Add a hobby or your favourite activity to make it more personal.');
      } else {
        tips.push('Your bio is solid. Keep it authentic and refresh it when your interests change.');
      }
      if (availability.length === 0) {
        tips.push('Set your availability so people know when to reach out.');
      } else {
        tips.push('You have availability set — update it whenever your schedule changes.');
      }
      if (preferences.length < 2) {
        tips.push('Add at least 2 interests to improve your discovery ranking.');
      } else if (preferences.length < 5) {
        tips.push('A few more interests will help people find common ground with you.');
      } else {
        tips.push('Great variety of interests! Keep them current.');
      }
      return {
        intro: null,
        bullets: tips.slice(0, 5),
        callToAction: 'Edit Profile',
        completionScore,
        showOptionsAfter: false,
      };
    }

    case 'booking_help': {
      const reasons = [];
      if (!hasProfilePhoto)          reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)           reasons.push('Missing or very short bio — people want to know who they are meeting.');
      if (availability.length === 0) reasons.push('No availability set — people cannot see when you are free.');
      if (preferences.length < 2)   reasons.push('Too few interests — add more so the system matches you better.');

      if (reasons.length === 0) {
        return {
          intro: 'Your profile looks complete! 👍 A few tips to boost bookings:',
          bullets: [
            'Log in regularly — active profiles appear higher in search.',
            'Update your availability often so people know you are reachable.',
            'Refresh your bio occasionally to keep it feeling current.',
          ],
          callToAction: null,
          completionScore,
          showOptionsAfter: true,
        };
      }
      return {
        intro: 'Here are the likely reasons you are not getting bookings:',
        bullets: reasons.slice(0, 5),
        callToAction: 'Fix Issues',
        completionScore,
        showOptionsAfter: false,
      };
    }

    default:
      return {
        intro: null,
        bullets: [],
        callToAction: null,
        completionScore,
        showOptionsAfter: true, // unclear → always show options
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Groq fallback for unmatched typed messages.
//
// Spec prompt:
//   "User profile data: ${filteredData}
//    User message: ${message}
//    Give short, helpful suggestions to improve profile.
//    Max 3–4 lines. No extra explanation."
//
// filteredData = ALLOWED_FIELDS values only — no phone, email, location, etc.
// ─────────────────────────────────────────────────────────────────────────────
async function callGroqFallback(userMessage, summary) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null; // Groq not configured — caller handles null

  // Build filtered data string — ALLOWED_FIELDS only, human-readable
  const filteredData = [
    `Profile photo: ${summary.hasProfilePhoto ? 'yes' : 'no'}`,
    `Bio length: ${summary.bio.length} characters`,
    `Preferences count: ${summary.preferences.length}`,
    `Availability slots: ${summary.availability.length}`,
    `Completion score: ${summary.completionScore}%`,
    `Missing fields: ${summary.missingFields.length === 0 ? 'none' : summary.missingFields.join(', ')}`,
  ].join('\n');

  // Spec-exact Groq prompt
  const prompt =
    `User profile data:\n${filteredData}\n\nUser message:\n${userMessage}\n\n` +
    `Give short, helpful suggestions to improve profile.\nMax 3–4 lines. No extra explanation.`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content:
            'You are a friendly profile improvement assistant for a social app. ' +
            'Give concise, actionable tips based on the user\'s profile data and question. ' +
            'Keep your response to 3–4 short sentences. No extra explanation or preamble.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 150,
      temperature: 0.6,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    }
  );

  return res.data?.choices?.[0]?.message?.content?.trim() || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Polish logic-engine bullets with Groq (for /analyze only).
// Spec prompt: "Rewrite this in a friendly, short, and helpful tone: ${bullet}"
// ─────────────────────────────────────────────────────────────────────────────
async function polishBulletsWithGroq(bullets) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return bullets;

  const polished = [];
  for (const bullet of bullets) {
    try {
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
            {
              role: 'user',
              content: `Rewrite this in a friendly, short, and helpful tone: ${bullet}`,
            },
          ],
          max_tokens: 80,
          temperature: 0.5,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 4000,
        }
      );
      const rewritten = res.data?.choices?.[0]?.message?.content?.trim();
      polished.push(rewritten && rewritten.length > 0 && rewritten.length < 200 ? rewritten : bullet);
    } catch {
      polished.push(bullet);
    }
  }
  return polished;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/profile-assistant/consent ──────────────────────────────────────
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
// Button-triggered intents → LOGIC ONLY. Groq only polishes wording.
// Body: { intent: 'improve_profile' | 'booking_help' | 'complete_profile' }
router.post('/analyze', auth, async (req, res) => {
  try {
    const { intent } = req.body;
    const validIntents = ['improve_profile', 'booking_help', 'complete_profile'];

    if (!intent || !validIntents.includes(intent)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_INTENT',
        message: "I didn't fully understand that. Try one of the options below.",
        showOptions: true,
      });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({
        success: false,
        code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.',
      });
    }

    const summary  = buildSafeProfileSummary(user);
    const result   = runLogicEngine(intent, summary);
    const polished = await polishBulletsWithGroq(result.bullets);

    return res.json({
      success: true,
      source: 'logic',
      intent,
      completionScore:  result.completionScore,
      intro:            result.intro,
      bullets:          polished,
      callToAction:     result.callToAction,
      showOptionsAfter: result.showOptionsAfter,
    });

  } catch (err) {
    console.error('[ProfileAssistant] analyze error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/profile-assistant/chat ─────────────────────────────────────────
// Typed messages → intent match → LOGIC, else Groq fallback.
// Body: { message: string, groqCallCount: number }
// groqCallCount is the session's running count sent from client; server also
// enforces the daily cap independently.
router.post('/chat', auth, async (req, res) => {
  try {
    const { message, groqCallCount = 0 } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        code: 'EMPTY_MESSAGE',
        message: "I didn't catch that — could you rephrase?",
        showOptions: true,
      });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({
        success: false,
        code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.',
      });
    }

    const summary = buildSafeProfileSummary(user);

    // ── Try keyword intent match first ────────────────────────────────────
    const matchedIntent = matchIntent(message.trim());

    if (matchedIntent) {
      // Matched → run logic, never call Groq for this path
      const result   = runLogicEngine(matchedIntent, summary);
      const polished = await polishBulletsWithGroq(result.bullets);

      // After 2–3 AI replies (or any logic reply per spec), re-show options
      const showOptionsAfter = result.showOptionsAfter || groqCallCount >= 2;

      return res.json({
        success: true,
        source: 'logic',
        intent: matchedIntent,
        completionScore:  result.completionScore,
        intro:            result.intro,
        bullets:          polished,
        callToAction:     result.callToAction,
        showOptionsAfter,
      });
    }

    // ── No match → Groq fallback (if within daily limit) ─────────────────
    const userId    = req.userId.toString();
    const usedToday = groqCallsToday(userId);

    if (usedToday >= GROQ_DAILY_LIMIT) {
      // Daily cap hit — show options + soft limit message
      return res.json({
        success: true,
        source: 'limit',
        intro: "You've reached today's AI assist limit.",
        bullets: [
          'Try one of the quick options below — they work instantly.',
          'Your daily AI limit resets at midnight.',
        ],
        callToAction: null,
        showOptionsAfter: true,
        completionScore: summary.completionScore,
      });
    }

    // Groq not configured? → return graceful fallback message
    if (!process.env.GROQ_API_KEY) {
      return res.json({
        success: true,
        source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [],
        callToAction: null,
        showOptionsAfter: true,
        completionScore: summary.completionScore,
      });
    }

    // ── Call Groq ─────────────────────────────────────────────────────────
    incrementGroqUsage(userId);
    let groqReply = null;

    try {
      groqReply = await callGroqFallback(message.trim(), summary);
    } catch (groqErr) {
      console.error('[ProfileAssistant] Groq call failed:', groqErr.message);
    }

    if (!groqReply) {
      // Groq failed → spec fallback message
      return res.json({
        success: true,
        source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [],
        callToAction: null,
        showOptionsAfter: true,
        completionScore: summary.completionScore,
      });
    }

    // After 2–3 AI replies show options again (per spec)
    const newGroqCount = groqCallCount + 1;
    const showOptionsAfter = newGroqCount >= 2;

    return res.json({
      success: true,
      source: 'groq',
      groqReply,           // free-form text from Groq — rendered differently in UI
      groqCallCount: newGroqCount,
      showOptionsAfter,
      completionScore: summary.completionScore,
    });

  } catch (err) {
    console.error('[ProfileAssistant] chat error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
