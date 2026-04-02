// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant — full logic + AI backend.
//
// Endpoints:
//   POST /consent    — store profileBotConsent = true
//   POST /analyze    — button tap  → LOGIC only (Groq polishes wording only)
//   POST /chat       — typed msg   → intent match → logic, else Groq fallback
//   POST /ai-fix     — "Let AI fix it" → Groq generates field values → applies
//                      to the user's profile automatically
//
// Security:
//   • AI never has direct DB access
//   • Only ALLOWED_FIELDS ever leave buildSafeProfileSummary()
//   • AI-generated values go through the same field validation before save
//   • Max 5 Groq calls/user/day (shared across /chat and /ai-fix)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const User    = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_FIELDS   = ['hasProfilePhoto', 'bio', 'preferences', 'availability', 'completionScore', 'missingFields'];
const GROQ_DAILY_LIMIT = 5;
const groqDailyUsage   = new Map(); // userId → { date: 'YYYY-MM-DD', count }

// Fields that Groq is allowed to suggest new values for
const AI_FIXABLE_FIELDS = ['bio', 'preferences', 'availability'];

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER
// ─────────────────────────────────────────────────────────────────────────────

function getTodayStr() { return new Date().toISOString().slice(0, 10); }

function groqCallsToday(userId) {
  const e = groqDailyUsage.get(userId);
  return (!e || e.date !== getTodayStr()) ? 0 : e.count;
}

function incrementGroqUsage(userId) {
  const today = getTodayStr();
  const e = groqDailyUsage.get(userId);
  if (!e || e.date !== today) groqDailyUsage.set(userId, { date: today, count: 1 });
  else e.count += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Safe profile summary (ALLOWED_FIELDS only)
// ─────────────────────────────────────────────────────────────────────────────

function buildSafeProfileSummary(user) {
  const q            = user.questionnaire || {};
  const hasProfilePhoto = !!user.profilePhoto;
  const bio          = (q.bio || '').trim();
  const preferences  = [
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
// STEP 2 — Logic engine (deterministic, no AI)
// ─────────────────────────────────────────────────────────────────────────────

function runLogicEngine(intent, s) {
  const { missingFields, completionScore, hasProfilePhoto, bio, preferences, availability } = s;

  switch (intent) {
    case 'complete_profile': {
      if (missingFields.length === 0) {
        return { intro: `You're ${completionScore}% complete — all set! 🎉`,
          bullets: ['Refresh your bio every few weeks.', 'Keep availability updated.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      return {
        intro: `You're ${completionScore}% complete.`,
        bullets: missingFields.slice(0, 5).map(f => ({
          profilePhoto: 'Add a profile photo — profiles with photos get 3× more views.',
          bio:          'Add a bio (at least 10 characters) so others know who you are.',
          availability: 'Set your available time slots so people know when you can meet.',
          preferences:  'Add at least 2 interests or hangout preferences.',
          ageGroup:     'Set your age group for better match suggestions.',
          city:         'Add your city so nearby users can discover you.',
        }[f] || `Fill in your ${f}.`)),
        callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
      };
    }
    case 'improve_profile': {
      const tips = [];
      tips.push(!hasProfilePhoto
        ? 'Add a real, well-lit profile photo — it is the first thing people notice.'
        : 'Your photo looks good. Make sure it is recent and clearly shows your face.');
      tips.push(bio.length < 10
        ? 'Write a 2–3 sentence bio. Share what you enjoy and what kind of meetup you are open to.'
        : bio.length < 60 ? 'Your bio is a bit short. Add a hobby or your favourite activity.'
        : 'Your bio is solid. Keep it authentic and refresh it when your interests change.');
      tips.push(availability.length === 0
        ? 'Set your availability so people know when to reach out.'
        : 'You have availability set — update it whenever your schedule changes.');
      tips.push(preferences.length < 2
        ? 'Add at least 2 interests to improve your discovery ranking.'
        : preferences.length < 5 ? 'A few more interests will help people find common ground with you.'
        : 'Great variety of interests! Keep them current.');
      return { intro: null, bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }
    case 'booking_help': {
      const reasons = [];
      if (!hasProfilePhoto)          reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)           reasons.push('Missing or very short bio — people want to know who they are meeting.');
      if (availability.length === 0) reasons.push('No availability set — people cannot see when you are free.');
      if (preferences.length < 2)   reasons.push('Too few interests — add more so the system matches you better.');
      if (reasons.length === 0) {
        return { intro: 'Your profile looks complete! 👍 Tips to boost bookings:',
          bullets: ['Log in regularly — active profiles appear higher in search.',
            'Update your availability often.', 'Refresh your bio occasionally.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      return { intro: 'Here are the likely reasons you are not getting bookings:',
        bullets: reasons.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }
    default:
      return { intro: null, bullets: [], callToAction: null, completionScore, showOptionsAfter: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Groq: polish logic bullets (wording only, no data sent)
// ─────────────────────────────────────────────────────────────────────────────

async function polishBulletsWithGroq(bullets) {
  if (!process.env.GROQ_API_KEY || bullets.length === 0) return bullets;
  const polished = [];
  for (const bullet of bullets) {
    try {
      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama3-8b-8192',
        messages: [
          { role: 'system', content: 'Rewrite the sentence in a warm, concise, actionable tone. Return ONLY the sentence, no extra text.' },
          { role: 'user',   content: `Rewrite this in a friendly, short, and helpful tone: ${bullet}` },
        ],
        max_tokens: 80, temperature: 0.5,
      }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 4000 });
      const r = res.data?.choices?.[0]?.message?.content?.trim();
      polished.push(r && r.length > 0 && r.length < 200 ? r : bullet);
    } catch { polished.push(bullet); }
  }
  return polished;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Groq: chat fallback for unmatched typed messages
// ─────────────────────────────────────────────────────────────────────────────

function matchIntent(msg) {
  const l = msg.toLowerCase();
  if (/\b(booking|bookings|not getting|no booking|why.{0,20}book)\b/.test(l)) return 'booking_help';
  if (/\b(complet|missing|fill|incomplete|finish|setup|set up)\b/.test(l))     return 'complete_profile';
  if (/\b(improv|better|tips|help|profile|enhance|update|how to|what should)\b/.test(l)) return 'improve_profile';
  return null;
}

async function callGroqFallback(userMessage, summary) {
  if (!process.env.GROQ_API_KEY) return null;
  const filteredData = [
    `Profile photo: ${summary.hasProfilePhoto ? 'yes' : 'no'}`,
    `Bio length: ${summary.bio.length} characters`,
    `Preferences count: ${summary.preferences.length}`,
    `Availability slots: ${summary.availability.length}`,
    `Completion: ${summary.completionScore}%`,
    `Missing: ${summary.missingFields.join(', ') || 'none'}`,
  ].join('\n');
  const prompt = `User profile data:\n${filteredData}\n\nUser message:\n${userMessage}\n\nGive short, helpful suggestions to improve profile.\nMax 3–4 lines. No extra explanation.`;
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama3-8b-8192',
    messages: [
      { role: 'system', content: 'You are a friendly profile improvement assistant for a social app. Give concise, actionable tips. 3–4 sentences max.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 150, temperature: 0.6,
  }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 8000 });
  return res.data?.choices?.[0]?.message?.content?.trim() || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — AI Fix: Groq generates actual field values and applies them
//
// What Groq generates:
//   bio        → a 2–3 sentence bio suggestion based on questionnaire context
//   preferences → 3 interest suggestions
//   availability → 2–3 time slot suggestions
//
// What Groq is NOT allowed to touch:
//   profilePhoto, ageGroup, city, email, phone, location, any internal field
//
// After generation, values are saved to user.questionnaire via the same
// Mongoose path as regular profile updates — no special bypass.
// ─────────────────────────────────────────────────────────────────────────────

async function generateAndApplyAiFix(user, summary) {
  if (!process.env.GROQ_API_KEY) {
    return { success: false, message: 'AI fix requires GROQ_API_KEY to be configured on the server.' };
  }

  const fixable = summary.missingFields.filter(f => AI_FIXABLE_FIELDS.includes(f));
  if (fixable.length === 0) {
    return {
      success: true,
      message: 'Your profile data looks complete — no AI fixes needed for these fields!',
      applied: [],
    };
  }

  // Build context from safe questionnaire fields only (no PII)
  const q = user.questionnaire || {};
  const safeContext = [
    q.hangoutPreferences?.length ? `Hangout preferences: ${q.hangoutPreferences.join(', ')}` : null,
    q.interests?.length           ? `Interests: ${q.interests.join(', ')}`                   : null,
    q.mood                        ? `Mood/vibe: ${q.mood}`                                   : null,
    q.personalityType             ? `Personality: ${q.personalityType}`                      : null,
    q.lookingForOnHumrah?.length  ? `Looking for: ${q.lookingForOnHumrah.join(', ')}`        : null,
    q.comfortZones?.length        ? `Comfort zones: ${q.comfortZones.join(', ')}`            : null,
  ].filter(Boolean).join('\n');

  const fieldsToFix = fixable.map(f => {
    switch (f) {
      case 'bio':          return 'bio: write a warm, genuine 2–3 sentence bio (max 140 characters) based on the context. No emojis.';
      case 'preferences':  return 'interests: suggest exactly 3 relevant interests as a JSON array of strings.';
      case 'availability': return 'availableTimes: suggest 2–3 time slots as a JSON array of strings like ["Weekday evenings", "Weekend mornings"].';
      default:             return null;
    }
  }).filter(Boolean);

  const prompt = `You are helping a user on a social companion app complete their profile.

User context (safe, non-PII):
${safeContext || 'No additional context available.'}

Missing fields to generate:
${fieldsToFix.join('\n')}

Return a single JSON object with ONLY these keys: ${fixable.join(', ')}.
For bio: a string.
For interests: an array of strings.
For availableTimes: an array of strings.
No explanation, no markdown, no extra keys. Just the JSON object.`;

  let generated;
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: 'Return only a valid JSON object. No markdown. No explanation.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 300, temperature: 0.7,
    }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 });

    const raw = res.data?.choices?.[0]?.message?.content?.trim() || '{}';
    // Strip markdown code fences if Groq wraps it anyway
    const clean = raw.replace(/```json|```/g, '').trim();
    generated = JSON.parse(clean);
  } catch (err) {
    console.error('[AI Fix] Groq generation failed:', err.message);
    return { success: false, message: 'AI could not generate suggestions right now. Please try again.' };
  }

  // ── Apply generated values to the user document ──────────────────────────
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

  // interests — array of strings, max 5
  if (Array.isArray(generated.interests) && generated.interests.length > 0) {
    const interests = generated.interests
      .filter(i => typeof i === 'string' && i.trim().length > 0)
      .slice(0, 5)
      .map(i => i.trim());
    if (interests.length > 0) {
      const existing = Array.isArray(user.questionnaire.interests) ? user.questionnaire.interests : [];
      user.questionnaire.interests = [...new Set([...existing, ...interests])].slice(0, 8);
      applied.push({ field: 'interests', value: interests });
    }
  }

  // availableTimes — array of strings, max 5
  if (Array.isArray(generated.availableTimes) && generated.availableTimes.length > 0) {
    const times = generated.availableTimes
      .filter(t => typeof t === 'string' && t.trim().length > 0)
      .slice(0, 5)
      .map(t => t.trim());
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

  return {
    success: true,
    message: `AI updated ${applied.length} field${applied.length > 1 ? 's' : ''} on your profile! ✅`,
    applied,
    newCompletionScore: Math.round(((6 - buildSafeProfileSummary(user).missingFields.length) / 6) * 100),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/profile-assistant/consent
router.post('/consent', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.profileBotConsent = true;
    await user.save();
    res.json({ success: true, message: 'Access granted.' });
  } catch (err) {
    console.error('[Assistant] consent error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/profile-assistant/analyze   (button tap → logic only)
router.post('/analyze', auth, async (req, res) => {
  try {
    const { intent } = req.body;
    const valid = ['improve_profile', 'booking_help', 'complete_profile'];
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
    const bullets = await polishBulletsWithGroq(result.bullets);
    return res.json({ success: true, source: 'logic', intent,
      completionScore: result.completionScore, intro: result.intro,
      bullets, callToAction: result.callToAction, showOptionsAfter: result.showOptionsAfter });
  } catch (err) {
    console.error('[Assistant] analyze error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/profile-assistant/chat   (typed message → intent match → logic, else Groq)
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
    if (matched) {
      const result  = runLogicEngine(matched, summary);
      const bullets = await polishBulletsWithGroq(result.bullets);
      return res.json({ success: true, source: 'logic', intent: matched,
        completionScore: result.completionScore, intro: result.intro,
        bullets, callToAction: result.callToAction,
        showOptionsAfter: result.showOptionsAfter || groqCallCount >= 2 });
    }
    const userId = req.userId.toString();
    if (groqCallsToday(userId) >= GROQ_DAILY_LIMIT) {
      return res.json({ success: true, source: 'limit',
        intro: "You've reached today's AI assist limit.",
        bullets: ['Try one of the quick options below.', 'Your daily AI limit resets at midnight.'],
        callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    }
    if (!process.env.GROQ_API_KEY) {
      return res.json({ success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    }
    incrementGroqUsage(userId);
    let groqReply = null;
    try { groqReply = await callGroqFallback(message.trim(), summary); } catch {}
    if (!groqReply) {
      return res.json({ success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    }
    return res.json({ success: true, source: 'groq', groqReply,
      groqCallCount: groqCallCount + 1,
      showOptionsAfter: groqCallCount + 1 >= 2, completionScore: summary.completionScore });
  } catch (err) {
    console.error('[Assistant] chat error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/profile-assistant/ai-fix
// Groq reads safe profile data, generates field values, saves them to the DB.
// Called when user taps "Let AI fix it" in the Fix bottom sheet.
router.post('/ai-fix', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.profileBotConsent) {
      return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.' });
    }

    const userId = req.userId.toString();
    if (groqCallsToday(userId) >= GROQ_DAILY_LIMIT) {
      return res.status(429).json({ success: false, code: 'DAILY_LIMIT',
        message: "You've reached today's AI assist limit. Try again tomorrow or fix manually." });
    }

    incrementGroqUsage(userId);
    const summary = buildSafeProfileSummary(user);
    const result  = await generateAndApplyAiFix(user, summary);

    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[Assistant] ai-fix error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
