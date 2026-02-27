// middleware/moderation.js
// ─────────────────────────────────────────────────────────────────────────────
// SHARED MODERATION ENGINE
// Used by: routes/users.js, routes/profile.js
//
// Pipeline per text field:
//   1. Normalize   → collapse leet/spaced bypasses
//   2. Hard-block  → reject if solicitation / sexual / self-harm
//   3. Auto-clean  → silently strip phone numbers, platforms, URLs
//   4. OpenAI      → catch subtle hate/harassment (1 batched call)
//
// On violation: field is wiped to "" AND user gets a moderation strike in DB.
// 3 strikes  → account auto-suspended.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────────────

const MODERATED_TEXT_FIELDS = ['bio', 'goodMeetupMeaning', 'vibeQuote'];
const MIN_LENGTH_FOR_AI     = 15;

const OPENAI_THRESHOLDS = {
  sexual:                    0.4,
  'sexual/minors':           0.01,
  harassment:                0.5,
  'harassment/threatening':  0.3,
  hate:                      0.4,
  'hate/threatening':        0.3,
  violence:                  0.7,
  'violence/graphic':        0.4,
  'self-harm':               0.3,
  'self-harm/intent':        0.1,
  'self-harm/instructions':  0.1,
};

// ─── Layer 1: Normalization ───────────────────────────────────────────────────

const LEET_MAP = {
  '@':'a','4':'a','3':'e','1':'i','!':'i',
  '0':'o','5':'s','$':'s','7':'t','+':'t',
  '8':'b','6':'g','9':'g',
};

function normalizeText(text) {
  let t = text.toLowerCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Fullwidth unicode → ASCII
  t = t.replace(/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // Leet speak
  t = t.replace(/[@4310!5$78+69]/g, c => LEET_MAP[c] || c);
  // Collapse spaced-out chars: "w h a t s a p p" → "whatsapp"
  t = t.replace(/\b(\w)([\s.\-_]+\w){2,}/g, m => m.replace(/[\s.\-_]+/g, ''));
  t = t.replace(/(\w)[.\-_](\w)/g, '$1$2');
  return t;
}

// ─── Layer 2A: Auto-clean (strip silently, save the rest) ────────────────────

const AUTO_CLEAN_PATTERNS = [
  /(?:(?:\+|00)?91[\s\-.]?)?[6-9]\d{9}/g,          // Indian mobile numbers
  /\b[6-9](?:[\s.\-]{1,3}\d){9}\b/g,               // Spaced-out numbers
  /\b(whatsapp|whats\s*app|watsapp|wa\.me|telegram|t\.me|instagram|insta|snapchat|snap)\b/gi,
  /\b(upi|paytm|gpay|google\s*pay|phonepe|bhim)\b/gi,
  /[₹$€£]\s*\d+/g,
  /\b\d+\s*(?:rs|inr|rupees?)\b/gi,
  /\bper\s*(?:hour|hr|day|session|meet|visit|call)\b/gi,
  /\b(?:rate|charge|fee|cost)s?\s*[:=]?\s*\d+/gi,
  /https?:\/\/[^\s]*/gi,
  /www\.[^\s]*/gi,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi,
];

function autoCleanText(text) {
  let c = text;
  for (const p of AUTO_CLEAN_PATTERNS) {
    p.lastIndex = 0;
    c = c.replace(p, '');
  }
  return c.replace(/\s{2,}/g, ' ').trim();
}

// ─── Layer 2B: Hard-block (reject entire submission) ─────────────────────────

const HARD_BLOCK_ORIGINAL = [
  // Contact sharing
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me)\b/i,
  /\b(reach\s*(me|out)|hit\s*me\s*up|ping\s*me|slide\s*in(to)?\s*(my|the))\b/i,
  /\b(my\s*(number|no\.?|num|contact|handle|id)\s*(?:is|:))/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,
  // Solicitation / sexual
  /\bfor\s*sex\b/i,
  /\bsex\s*(available|meet|chat|friend|partner|service|work)\b/i,
  /\bavailable\s*for\s*sex\b/i,
  /\b(playboy|play\s*boy|gigolo|call\s*girl|escort)\b/i,
  /\b(hookup|hook\s*up|nsa|one\s*night|fwb|friends?\s*with\s*benefits)\b/i,
  /\b(paid\s*(service|meet|session|companion|friend)|rate\s*card)\b/i,
  /\b(sugar\s*(daddy|mama|baby)|adult\s*(service|fun|meet))\b/i,
  // Self-harm
  /\b(kill\s*(my)?self|want\s*to\s*die|end\s*(my\s*)?life|commit\s*suicide)\b/i,
];

const HARD_BLOCK_NORMALIZED = [
  /whatsapp/, /telegram/, /instagram/, /snapchat/,
  /[6-9]\d{9}/,     // 10-digit phone after collapse
  /\b\d{10,}\b/,    // any 10+ digit run
  /playboy/, /gigolo/, /callgirl/, /escort/,
  /forsex/, /sexavailable/, /availableforsex/,
];

function runHardBlockChecks(original, normalized) {
  for (const p of HARD_BLOCK_ORIGINAL) {
    if (p.test(original)) return {
      blocked: true,
      reason: 'solicitation_or_sexual_content',
      message: "This content isn't allowed. Please keep your profile genuine.",
    };
  }
  for (const p of HARD_BLOCK_NORMALIZED) {
    if (p.test(normalized)) return {
      blocked: true,
      reason: 'bypass_attempt',
      message: "Please don't include contact details or restricted content — even spaced out.",
    };
  }
  return { blocked: false };
}

// ─── Layer 3: OpenAI ─────────────────────────────────────────────────────────

async function checkWithOpenAI(fieldTexts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production')
      console.error('[MODERATION] ❌ OPENAI_API_KEY missing in production — AI layer disabled');
    return { safe: true, flaggedCategories: [] };
  }

  const input = Object.entries(fieldTexts)
    .map(([f, t]) => `[${f}]: ${t}`)
    .join('\n---\n');

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/moderations',
      { input },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 6000,
      }
    );

    const result = res.data.results[0];
    const scores = result.category_scores;
    const flagged = [];

    for (const [cat, threshold] of Object.entries(OPENAI_THRESHOLDS)) {
      if ((scores[cat] ?? 0) >= threshold) flagged.push(cat);
    }

    return { safe: flagged.length === 0, flaggedCategories: flagged };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401)
      console.error('[MODERATION] ❌ Invalid OPENAI_API_KEY — set a valid key in Render env vars');
    else if (status === 429)
      console.warn('[MODERATION] ⚠️ OpenAI rate limit hit — skipping AI layer');
    else
      console.error('[MODERATION] OpenAI unavailable (fail-open):', err.message);
    return { safe: true, flaggedCategories: [] }; // fail-open
  }
}

function getAIMessage(cats) {
  if (cats.some(c => c.startsWith('sexual')))     return 'Please keep your profile appropriate for all audiences.';
  if (cats.some(c => c.startsWith('hate')))       return 'Hateful language is not allowed in profiles.';
  if (cats.some(c => c.startsWith('harassment'))) return 'Please keep your profile friendly and welcoming.';
  if (cats.some(c => c.startsWith('self-harm')))  return "This content isn't allowed. Please reach out to someone if you're struggling.";
  if (cats.some(c => c.startsWith('violence')))   return 'Violent content is not allowed in profiles.';
  return "This content doesn't meet our community guidelines.";
}

// ─── Core Pipeline ────────────────────────────────────────────────────────────

/**
 * moderateQuestionnaire(questionnaire)
 *
 * Returns:
 *   cleanedQuestionnaire  — full object, text fields replaced with cleaned values
 *   violations            — array of { field, reason } for DB logging
 *   errors                — array of { field, code, message } for 422 response
 */
async function moderateQuestionnaire(questionnaire) {
  const errors     = [];
  const violations = []; // for DB strike logging
  const cleaned    = { ...questionnaire };
  const textsForAI = {};

  for (const field of MODERATED_TEXT_FIELDS) {
    const raw = questionnaire[field];
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const normalized = normalizeText(trimmed);

    // Hard-block check
    const block = runHardBlockChecks(trimmed, normalized);
    if (block.blocked) {
      cleaned[field] = '';  // wipe from DB
      violations.push({ field, reason: block.reason, originalValue: trimmed });
      errors.push({ field, code: block.reason === 'bypass_attempt' ? 'BYPASS_DETECTED' : 'HARD_BLOCK', message: block.message });
      continue;
    }

    // Auto-clean (strip contact info silently)
    const autoCleaned = autoCleanText(trimmed);
    if (autoCleaned !== trimmed) {
      violations.push({ field, reason: 'auto_cleaned', originalValue: trimmed, cleanedValue: autoCleaned });
    }
    cleaned[field] = autoCleaned;

    if (normalized.length >= MIN_LENGTH_FOR_AI) {
      textsForAI[field] = normalized;
    }
  }

  // Single batched OpenAI call
  if (Object.keys(textsForAI).length > 0 && errors.length === 0) {
    const ai = await checkWithOpenAI(textsForAI);
    if (!ai.safe) {
      const msg = getAIMessage(ai.flaggedCategories);
      for (const field of Object.keys(textsForAI)) {
        cleaned[field] = '';
        violations.push({ field, reason: 'ai_flagged', categories: ai.flaggedCategories });
        errors.push({ field, code: 'AI_FLAGGED', categories: ai.flaggedCategories, message: msg });
      }
    }
  }

  return { cleanedQuestionnaire: cleaned, violations, errors };
}

module.exports = { moderateQuestionnaire, MODERATED_TEXT_FIELDS };
