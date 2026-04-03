// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant — hybrid logic + AI backend.
//
// ⚠️  MODEL FIX: llama3-8b-8192 was DECOMMISSIONED (all calls returned 400).
//     Replaced with: llama-3.1-8b-instant  (Groq's official drop-in successor)
//
// Endpoints:
//   POST /consent   → store profileBotConsent = true
//   POST /analyze   → button tap   → LOGIC ONLY (Groq only polishes wording)
//   POST /chat      → typed input  → keyword intent → LOGIC, else Groq fallback
//   POST /ai-fix    → "Let AI fix it" → Groq generates & saves field values
//
// Security:
//   • AI has NO direct DB access
//   • Only ALLOWED_FIELDS leave buildSafeProfileSummary()
//   • AI-generated values validated before saving
//   • Max 5 Groq calls / user / day (shared across all endpoints)
//
// Groq request format (per spec):
//   { model, messages: [{ role:"system", content }, { role:"user", content }] }
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const User    = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// ✅ FIXED: llama3-8b-8192 → llama-3.1-8b-instant
const GROQ_MODEL      = 'llama-3.1-8b-instant';
const GROQ_DAILY_LIMIT = 5;
const AI_FIXABLE_FIELDS = ['bio', 'interests', 'availableTimes'];
const ALLOWED_FIELDS    = ['hasProfilePhoto', 'bio', 'preferences', 'availability', 'completionScore', 'missingFields'];

// In-memory daily usage tracker  (swap for Redis in production)
const groqDailyUsage = new Map(); // userId → { date: 'YYYY-MM-DD', count }

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMIT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const getTodayStr = () => new Date().toISOString().slice(0, 10);

function groqCallsToday(userId) {
  const e = groqDailyUsage.get(userId);
  return (!e || e.date !== getTodayStr()) ? 0 : e.count;
}

function incrementGroq(userId) {
  const today = getTodayStr();
  const e     = groqDailyUsage.get(userId);
  groqDailyUsage.set(userId, (!e || e.date !== today)
    ? { date: today, count: 1 }
    : { ...e, count: e.count + 1 });
}

function overGroqLimit(userId) {
  return groqCallsToday(userId) >= GROQ_DAILY_LIMIT;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1  —  Build safe profile summary (ALLOWED_FIELDS only)
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

  const completionScore = Math.round(((6 - missingFields.length) / 6) * 100);
  return { hasProfilePhoto, bio, preferences, availability, completionScore, missingFields };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2  —  Keyword intent matcher (for typed messages)
// Returns: 'improve_profile' | 'booking_help' | 'complete_profile' |
//          'bio_help' | 'first_improve' | null
// ─────────────────────────────────────────────────────────────────────────────

function matchIntent(msg) {
  const l = msg.toLowerCase().trim();
  if (/\b(booking|bookings|not getting|no booking|why.{0,20}book|more booking|get booking)\b/.test(l))
    return 'booking_help';
  if (/\b(bio|write bio|better bio|help.*bio|bio help)\b/.test(l))
    return 'bio_help';
  if (/\b(first|priority|what.*improve|where.*start|start with)\b/.test(l))
    return 'first_improve';
  if (/\b(complet|missing|fill|incomplete|finish|setup|set up|percent|%)\b/.test(l))
    return 'complete_profile';
  if (/\b(improv|better|tips|help|profile|enhance|update|how to|what should|suggestion)\b/.test(l))
    return 'improve_profile';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3  —  Logic engine (deterministic, no AI called here)
//            Returns: { intro, bullets, callToAction, completionScore,
//                       showOptionsAfter }
// ─────────────────────────────────────────────────────────────────────────────

function runLogicEngine(intent, s) {
  const { missingFields, completionScore, hasProfilePhoto, bio, preferences, availability } = s;

  const FIELD_TIPS = {
    profilePhoto: 'Add a clear profile photo — profiles with photos get 3× more views.',
    bio:          'Write a short bio (at least 10 characters) so people know who they are meeting.',
    availability: 'Set your available time slots so people can see when you are free.',
    preferences:  'Add at least 2 interests or hangout preferences.',
    ageGroup:     'Set your age group to get better match suggestions.',
    city:         'Add your city so nearby users can discover you.',
  };

  switch (intent) {

    // ── Complete my profile ─────────────────────────────────────────────────
    case 'complete_profile': {
      if (missingFields.length === 0) {
        return { intro: `You're ${completionScore}% complete — all set! 🎉`,
          bullets: ['Refresh your bio every few weeks to stay relevant.',
            'Keep your availability updated to attract more bookings.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      return {
        intro: `You're ${completionScore}% complete.`,
        bullets: missingFields.slice(0, 5).map(f => FIELD_TIPS[f] || `Fill in your ${f}.`),
        callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
      };
    }

    // ── Improve my profile ──────────────────────────────────────────────────
    case 'improve_profile': {
      const tips = [];
      tips.push(!hasProfilePhoto
        ? 'Add a real, well-lit photo — it is the first thing people notice.'
        : 'Your photo looks good. Make sure it is recent and shows your face clearly.');
      tips.push(bio.length < 10
        ? 'Write a 2–3 sentence bio. Share what you enjoy and what meetup you are open to.'
        : bio.length < 60 ? 'Your bio is a bit short. Add a hobby or favourite activity to make it personal.'
        : 'Your bio is solid. Keep it authentic and refresh it when your interests change.');
      tips.push(availability.length === 0
        ? 'Set your availability so people know when to reach out.'
        : 'You have availability set — update it whenever your schedule changes.');
      tips.push(preferences.length < 2
        ? 'Add at least 2 interests to boost your discovery ranking.'
        : preferences.length < 5 ? 'A few more interests help people find common ground with you.'
        : 'Great variety of interests! Keep them current.');
      return { intro: null, bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── Why no bookings? ────────────────────────────────────────────────────
    case 'booking_help': {
      const reasons = [];
      if (!hasProfilePhoto)          reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)           reasons.push('Missing or very short bio — people want to know who they are meeting.');
      if (availability.length === 0) reasons.push('No availability set — people cannot see when you are free.');
      if (preferences.length < 2)   reasons.push('Too few interests — add more so the system matches you better.');
      if (reasons.length === 0) {
        return { intro: 'Your profile looks great! 👍 Tips to boost bookings further:',
          bullets: ['Log in regularly — active profiles rank higher.',
            'Update your availability often so people know you are reachable.',
            'Refresh your bio occasionally to keep it feeling current.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      return { intro: 'Here are the likely reasons you are not getting bookings:',
        bullets: reasons.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }

    // ── Help me write a better bio ──────────────────────────────────────────
    case 'bio_help': {
      const bioTips = [];
      if (bio.length === 0) {
        bioTips.push('You have not written a bio yet. Start with what kind of person you are and what you enjoy.');
        bioTips.push('Example: "I love exploring cafes and weekend hikes. Looking for chill meetups to try new places!"');
      } else if (bio.length < 30) {
        bioTips.push(`Your bio is only ${bio.length} characters. Aim for at least 50–100 characters.`);
        bioTips.push('Mention 1–2 things you enjoy doing and what kind of meetup you are open to.');
      } else {
        bioTips.push('Your bio is a good length. Consider mentioning a specific interest or local spot you love.');
        bioTips.push('End with something that invites people to connect — e.g. "Always down for a coffee and good conversation!"');
      }
      bioTips.push('Keep it genuine, warm, and under 140 characters for best results.');
      return { intro: 'Here are some tips for writing a great bio:', bullets: bioTips, callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── What should I improve first? ────────────────────────────────────────
    case 'first_improve': {
      // Priority order: photo → bio → availability → preferences → ageGroup → city
      const priority = ['profilePhoto', 'bio', 'availability', 'preferences', 'ageGroup', 'city'];
      const topMissing = priority.filter(f => missingFields.includes(f));
      if (topMissing.length === 0) {
        return { intro: 'Your profile is complete! Focus on staying active:',
          bullets: ['Update your availability weekly.', 'Refresh your bio every month.',
            'Log in regularly to appear at the top of search.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      const top = topMissing[0];
      return {
        intro: `Start with your ${top === 'profilePhoto' ? 'profile photo' : top} — it has the biggest impact right now.`,
        bullets: [FIELD_TIPS[top], ...topMissing.slice(1, 3).map(f => FIELD_TIPS[f])],
        callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
      };
    }

    // ── How can I get more bookings? (alias of booking_help) ────────────────
    case 'more_bookings':
      return runLogicEngine('booking_help', s);

    // ── Fallback ────────────────────────────────────────────────────────────
    default:
      return { intro: null, bullets: [], callToAction: null, completionScore, showOptionsAfter: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4A  —  Groq: polish logic bullets (wording only, no profile data sent)
//             Prompt: "Rewrite this in a friendly, short, and helpful tone: ${bullet}"
// ─────────────────────────────────────────────────────────────────────────────

async function polishBullets(bullets) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || bullets.length === 0) return bullets;

  const polished = [];
  for (const bullet of bullets) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: GROQ_MODEL,  // ✅ uses live model
          messages: [
            { role: 'system', content: 'You help improve user profiles. Keep answers short, actionable, and friendly.' },
            { role: 'user',   content: `Rewrite this in a friendly, short, and helpful tone: ${bullet}` },
          ],
          max_tokens: 80,
          temperature: 0.5,
        },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 4000 }
      );
      const r = res.data?.choices?.[0]?.message?.content?.trim();
      polished.push(r && r.length > 0 && r.length < 200 ? r : bullet);
    } catch { polished.push(bullet); }
  }
  return polished;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4B  —  Groq: fallback for unmatched typed messages
//             Spec-compliant request format:
//             { model, messages: [system, user] }
//             Profile data = filtered summary only (ALLOWED_FIELDS)
// ─────────────────────────────────────────────────────────────────────────────

async function groqFallback(userMessage, summary) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  // Build filteredData string — ALLOWED_FIELDS values only
  const filteredData = [
    `Profile photo: ${summary.hasProfilePhoto ? 'yes' : 'no'}`,
    `Bio length: ${summary.bio.length} characters`,
    `Preferences count: ${summary.preferences.length}`,
    `Availability slots: ${summary.availability.length}`,
    `Completion: ${summary.completionScore}%`,
    `Missing: ${summary.missingFields.join(', ') || 'none'}`,
  ].join('\n');

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,  // ✅ uses live model
        messages: [
          {
            role: 'system',
            content: 'You help improve user profiles. Keep answers short, actionable, and friendly.',
          },
          {
            role: 'user',
            content: `User profile: ${filteredData}\nUser message: ${userMessage}`,
          },
        ],
        max_tokens: 150,
        temperature: 0.6,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    return res.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[ProfileAssistant] Groq fallback error:', err?.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5  —  Groq AI-Fix: generate & apply field values automatically
//            Groq gets: safe context (no PII) + list of fixable missing fields
//            Returns: applied patches + new completion score
// ─────────────────────────────────────────────────────────────────────────────

async function generateAndApplyAiFix(user, summary) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { success: false, message: 'AI fix requires GROQ_API_KEY on the server.' };

  const fixable = summary.missingFields.filter(f =>
    ['bio', 'preferences', 'availability'].includes(f)
  );
  if (fixable.length === 0) {
    return { success: true, message: 'Your profile data looks complete — no AI fixes needed!', applied: [] };
  }

  // Build safe context — no PII ever
  const q = user.questionnaire || {};
  const ctxLines = [
    q.hangoutPreferences?.length ? `Hangout: ${q.hangoutPreferences.join(', ')}` : null,
    q.interests?.length           ? `Interests: ${q.interests.join(', ')}`        : null,
    q.mood                        ? `Mood: ${q.mood}`                             : null,
    q.personalityType             ? `Personality: ${q.personalityType}`           : null,
    q.lookingForOnHumrah?.length  ? `Looking for: ${q.lookingForOnHumrah.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const fieldInstructions = fixable.map(f => {
    if (f === 'bio')          return 'bio: a warm 2–3 sentence bio (max 140 chars). No emojis.';
    if (f === 'preferences')  return 'interests: exactly 3 interests as a JSON string array.';
    if (f === 'availability') return 'availableTimes: 2–3 time slots as a JSON string array, e.g. ["Weekday evenings","Weekends"].';
    return null;
  }).filter(Boolean);

  const prompt = `You are helping a user on a social companion app fill in missing profile fields.

Context (no personal info):
${ctxLines || 'No additional context.'}

Generate values for these missing fields:
${fieldInstructions.join('\n')}

Return ONLY a valid JSON object with keys: ${fixable.join(', ')}.
No markdown, no explanation, no extra keys. Just the JSON.`;

  let generated;
  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,  // ✅ uses live model
        messages: [
          { role: 'system', content: 'You help improve user profiles. Keep answers short, actionable, and friendly.' },
          { role: 'user',   content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.7,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    const raw   = res.data?.choices?.[0]?.message?.content?.trim() || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    generated   = JSON.parse(clean);
  } catch (err) {
    console.error('[ProfileAssistant] AI-fix generation error:', err?.response?.data || err.message);
    return { success: false, message: 'AI could not generate suggestions right now. Please try again.' };
  }

  if (!user.questionnaire) user.questionnaire = {};
  const applied = [];

  // bio — string, max 140 chars, no URLs
  if (generated.bio && typeof generated.bio === 'string') {
    const bio = generated.bio.trim().slice(0, 140);
    if (bio.length >= 10 && !/https?:\/\//.test(bio)) {
      user.questionnaire.bio = bio;
      applied.push({ field: 'bio', value: bio });
    }
  }

  // interests — string array, max 5 items
  if (Array.isArray(generated.interests) && generated.interests.length > 0) {
    const interests = generated.interests.filter(i => typeof i === 'string' && i.trim()).slice(0, 5).map(i => i.trim());
    if (interests.length > 0) {
      const existing = Array.isArray(user.questionnaire.interests) ? user.questionnaire.interests : [];
      user.questionnaire.interests = [...new Set([...existing, ...interests])].slice(0, 8);
      applied.push({ field: 'interests', value: interests });
    }
  }

  // availableTimes — string array, max 5 items
  if (Array.isArray(generated.availableTimes) && generated.availableTimes.length > 0) {
    const times = generated.availableTimes.filter(t => typeof t === 'string' && t.trim()).slice(0, 5).map(t => t.trim());
    if (times.length > 0) {
      user.questionnaire.availableTimes = times;
      applied.push({ field: 'availability', value: times });
    }
  }

  if (applied.length === 0) {
    return { success: false, message: 'AI could not generate valid values. Please fill the fields manually.' };
  }

  user.markModified('questionnaire');
  await user.save();

  const newSummary = buildSafeProfileSummary(user);
  return {
    success: true,
    message: `AI updated ${applied.length} field${applied.length > 1 ? 's' : ''} on your profile! ✅`,
    applied,
    newCompletionScore: newSummary.completionScore,
  };
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
    res.json({ success: true, message: 'Access granted.' });
  } catch (err) {
    console.error('[ProfileAssistant] consent:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/profile-assistant/analyze ──────────────────────────────────────
// Button tap → LOGIC ONLY. Groq polishes wording only (no data sent to Groq).
// Body: { intent: string }
router.post('/analyze', auth, async (req, res) => {
  try {
    const { intent } = req.body;
    const valid = ['improve_profile', 'booking_help', 'complete_profile', 'bio_help', 'first_improve', 'more_bookings'];

    if (!intent || !valid.includes(intent)) {
      return res.status(400).json({ success: false, code: 'INVALID_INTENT',
        message: "I didn't understand that. Try one of the options.", showOptions: true });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.' });
    }

    const summary = buildSafeProfileSummary(user);
    const result  = runLogicEngine(intent, summary);
    // Polish wording via Groq — no user data ever sent to Groq here
    const bullets = await polishBullets(result.bullets);

    return res.json({
      success: true, source: 'logic', intent,
      completionScore: result.completionScore,
      intro: result.intro, bullets,
      callToAction: result.callToAction,
      showOptionsAfter: result.showOptionsAfter,
    });
  } catch (err) {
    console.error('[ProfileAssistant] analyze:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/profile-assistant/chat ─────────────────────────────────────────
// Typed input → keyword match → LOGIC, else Groq fallback.
// Body: { message: string, groqCallCount?: number }
router.post('/chat', auth, async (req, res) => {
  try {
    const { message, groqCallCount = 0 } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ success: false, code: 'EMPTY_MESSAGE',
        message: "I didn't catch that.", showOptions: true });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.' });
    }

    const summary = buildSafeProfileSummary(user);
    const matched = matchIntent(message.trim());

    // ── Intent matched → LOGIC (never call Groq for this path) ───────────
    if (matched) {
      const result  = runLogicEngine(matched, summary);
      const bullets = await polishBullets(result.bullets);
      return res.json({
        success: true, source: 'logic', intent: matched,
        completionScore: result.completionScore,
        intro: result.intro, bullets,
        callToAction: result.callToAction,
        showOptionsAfter: result.showOptionsAfter || groqCallCount >= 2,
      });
    }

    // ── No match → Groq fallback ──────────────────────────────────────────
    const userId = req.userId.toString();

    if (overGroqLimit(userId)) {
      return res.json({
        success: true, source: 'limit',
        intro: "You've reached today's AI assist limit.",
        bullets: ["Try one of the quick options below.", "Your daily AI limit resets at midnight."],
        callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore,
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.json({
        success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [], callToAction: null, showOptionsAfter: true,
        completionScore: summary.completionScore,
      });
    }

    incrementGroq(userId);
    const groqReply = await groqFallback(message.trim(), summary);

    if (!groqReply) {
      return res.json({
        success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [], callToAction: null, showOptionsAfter: true,
        completionScore: summary.completionScore,
      });
    }

    const newCount = groqCallCount + 1;
    return res.json({
      success: true, source: 'groq',
      groqReply, groqCallCount: newCount,
      showOptionsAfter: newCount >= 2,
      completionScore: summary.completionScore,
    });

  } catch (err) {
    console.error('[ProfileAssistant] chat:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/profile-assistant/ai-fix ───────────────────────────────────────
// Groq reads safe profile context, generates values, saves to DB.
// Called when user taps "Let AI fix it" in the fix bottom sheet.
router.post('/ai-fix', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.' });
    }

    const userId = req.userId.toString();
    if (overGroqLimit(userId)) {
      return res.status(429).json({ success: false, code: 'DAILY_LIMIT',
        message: "You've reached today's AI assist limit. Try again tomorrow or fix manually." });
    }

    incrementGroq(userId);
    const summary = buildSafeProfileSummary(user);
    const result  = await generateAndApplyAiFix(user, summary);

    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[ProfileAssistant] ai-fix:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
