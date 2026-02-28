// middleware/moderation.js  v2
// ─────────────────────────────────────────────────────────────────────────────
// TIERED MODERATION ENGINE
// Used by: routes/users.js  routes/profile.js  routes/messages.js
//
// TIER SYSTEM:
//   LEVEL 0 – Auto-Clean   → strip silently, no strike, warn user in response
//   LEVEL 1 – Soft Block   → reject + warn, NO strike
//   LEVEL 2 – Moderate     → reject + 1 strike, temp restriction at 2 strikes
//   LEVEL 3 – Severe       → reject + 1 strike + immediate 7-day suspension
//
// STRIKE ESCALATION:
//   1 strike  → Warning
//   2 strikes → 24-hour chat restriction
//   3 strikes → 7-day account suspension
//   4 strikes → Permanent ban
//
// EXPIRY:
//   Strikes expire individually after 30 days
//   All strikes fully reset after 90 days clean activity
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const axios = require('axios');

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MODERATED_TEXT_FIELDS = ['bio', 'goodMeetupMeaning', 'vibeQuote'];
const MIN_LENGTH_FOR_AI     = 15;

const LEVEL = Object.freeze({
  AUTO_CLEAN : 0,
  SOFT       : 1,
  MODERATE   : 2,
  SEVERE     : 3,
});

// Strike count → enforcement rule
const STRIKE_RULES = Object.freeze({
  1: { action: 'warning',  duration: null, message: 'This is a warning. Further violations may restrict your account.' },
  2: { action: 'restrict', duration: 24,   message: 'Your chat access has been restricted for 24 hours.' },
  3: { action: 'suspend',  duration: 168,  message: 'Your account has been suspended for 7 days.' },
  4: { action: 'ban',      duration: null, message: 'Your account has been permanently banned.' },
});

const STRIKE_EXPIRY_DAYS = 30;
const CLEAN_RESET_DAYS   = 90;

// OpenAI category → violation level
const AI_CATEGORY_LEVEL = {
  'sexual/minors':          LEVEL.SEVERE,
  'hate/threatening':       LEVEL.SEVERE,
  'harassment/threatening': LEVEL.SEVERE,
  'self-harm/intent':       LEVEL.SEVERE,
  'self-harm/instructions': LEVEL.SEVERE,
  'violence/graphic':       LEVEL.SEVERE,
  'sexual':                 LEVEL.MODERATE,
  'hate':                   LEVEL.MODERATE,
  'harassment':             LEVEL.MODERATE,
  'self-harm':              LEVEL.MODERATE,
  'violence':               LEVEL.MODERATE,
};

const OPENAI_THRESHOLDS = {
  'sexual':                  0.4,
  'sexual/minors':           0.01,
  'harassment':              0.5,
  'harassment/threatening':  0.3,
  'hate':                    0.25,   // lowered: subtle hate often scores 0.2-0.35
  'hate/threatening':        0.2,
  'violence':                0.7,
  'violence/graphic':        0.4,
  'self-harm':               0.3,
  'self-harm/intent':        0.1,
  'self-harm/instructions':  0.1,
};

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 — TEXT NORMALIZATION
// Collapses "w h a t s a p p", leet speak, unicode tricks before regex runs.
// ═══════════════════════════════════════════════════════════════════════════════

const LEET_MAP = {
  '@':'a','4':'a','3':'e','1':'i','!':'i',
  '0':'o','5':'s','$':'s','7':'t','+':'t',
  '8':'b','6':'g','9':'g',
};

function normalizeText(text) {
  let t = text.toLowerCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[@4310!5$78+69]/g, c => LEET_MAP[c] || c);
  t = t.replace(/\b(\w)([\s.\-_]+\w){2,}/g, m => m.replace(/[\s.\-_]+/g, ''));
  t = t.replace(/(\w)[.\-_](\w)/g, '$1$2');
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2A — LEVEL 0: AUTO-CLEAN PATTERNS
// Strip silently, save the cleaned version. No strike. Warn user.
// ═══════════════════════════════════════════════════════════════════════════════

const AUTO_CLEAN_PATTERNS = [
  /(?:(?:\+|00)?91[\s\-.]?)?[6-9]\d{9}/g,
  /\b[6-9](?:[\s.\-]{1,3}\d){9}\b/g,
  /\b(whatsapp|whats\s*app|watsapp|wa\.me|telegram|t\.me|instagram|insta|snapchat|snap)\b/gi,
  /\b(upi|paytm|gpay|google\s*pay|phonepe|bhim|@okaxis|@oksbi|@ybl|@paytm)\b/gi,
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
  for (const p of AUTO_CLEAN_PATTERNS) { p.lastIndex = 0; c = c.replace(p, ''); }
  return c.replace(/\s{2,}/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2B — LEVEL 1: SOFT BLOCK PATTERNS
// Reject + warn. NO strike. Not severe enough to count against user.
// ═══════════════════════════════════════════════════════════════════════════════

const SOFT_BLOCK_PATTERNS = [
  /\b(hot\s*guy|hot\s*girl|sexy\s*(?:time|fun|vibes?)|flirt(y|ing)?)\b/i,
  /\b(looking\s*for\s*(fun|timepass|tp|good\s*time))\b/i,
  /\b(no\s*strings|casual\s*(?:meet|fun|hangout|relation))\b/i,
  /\b(open\s*minded\s*(guy|girl|person|meet))\b/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2B-HATE — LEVEL 2: HATE SPEECH PATTERNS (regex-first, before OpenAI)
// Catches explicit racial/religious/caste hatred that OpenAI often under-scores.
// Scores around 0.2-0.35 on OpenAI hate — below the 0.4 threshold.
// These patterns are unambiguous enough to hard-block at regex level.
// ═══════════════════════════════════════════════════════════════════════════════

const HATE_SPEECH_PATTERNS = [
  // ── Racial hatred ──────────────────────────────────────────────────────────
  /\bhate\s+(black|white|brown|asian|african|arab|jewish|muslim|hindu|sikh|christian)\s+(people|person|men|women|girls|guys|community)\b/i,
  /\b(black|white|brown|asian|african|arab|jewish|muslim|hindu|sikh)\s+people\s+(are|r)\s+(not\s+welcome|not\s+allowed|disgusting|dirty|inferior|ugly|stupid|criminals?|terrorists?|filthy)\b/i,
  /\bno\s+(black|white|brown|asian|african|arab|jewish|muslim|hindu|sikh|dalit|lower\s*caste)\s+(people|person|allowed|welcome|here|pls|please)\b/i,
  /\bonly\s+(fair|light\s*skin|white|upper\s*caste|hindu|muslim)\s+(people|person|allowed|welcome|connect)\b/i,
  /\b(blacks?|whiteys?|brownies?)\s+(not\s+welcome|stay\s+away|don'?t\s+connect|please\s+don'?t)\b/i,

  // ── Caste discrimination (India-specific) ──────────────────────────────────
  /\b(upper|lower)\s+caste\s+(only|not\s+welcome|stay\s+away|preferred|not\s+allowed)\b/i,
  /\b(brahmin|kshatriya|vaishya|shudra|dalit|obc|sc|st)\s+(only|not\s+welcome|not\s+allowed|stay\s+away)\b/i,
  /\bno\s+(dalit|sc|st|obc|lower\s*caste)\b/i,
  /\bcasteist\b/i,

  // ── Religious hatred ───────────────────────────────────────────────────────
  /\bhate\s+(muslim|hindu|christian|sikh|jewish|buddhist|jain|parsi)s?\b/i,
  /\b(muslims?|hindus?|christians?|sikhs?|jews?)\s+(not\s+welcome|not\s+allowed|stay\s+away|are\s+(terrorists?|criminals?|evil|bad\s+people))\b/i,

  // ── Skin tone discrimination ───────────────────────────────────────────────
  /\b(only|prefer|no)\s+(fair|dark|dusky|wheatish)\s+(skin|people|girls|guys|person)\b/i,
  /\b(dark\s*skin|black\s*skin)\s+(not\s+welcome|stay\s+away|not\s+my\s+type|disgusting)\b/i,
  /\balways\s+(be\s+)?happy\s+with\s+(white|fair|light)\b/i,   // exactly what was in the screenshot

  // ── Generic exclusion language ─────────────────────────────────────────────
  /\b(connect\s+me\s+only|only\s+connect)\s+(if\s+you\s+are|if)\s+(fair|light|white|upper\s*caste|hindu|brahmin|non\s*muslim)\b/i,
  /\bno\s+(minorities|untouchables?|refugees?|foreigners?|outsiders?)\b/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2C — LEVEL 2: MODERATE BLOCK PATTERNS
// Reject + 1 strike. Solicitation, explicit contact-sharing.
// ═══════════════════════════════════════════════════════════════════════════════

const MODERATE_BLOCK_ORIGINAL = [
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me)\b/i,
  /\b(reach\s*(me|out)|hit\s*me\s*up|ping\s*me|slide\s*in(to)?\s*(my|the))\b/i,
  /\b(my\s*(number|no\.?|num|contact|handle|id)\s*(?:is|:))/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,
  /\b(hookup|hook\s*up|nsa|fwb|friends?\s*with\s*benefits)\b/i,
  /\b(paid\s*(service|meet|session|companion|friend)|rate\s*card)\b/i,
  /\b(sugar\s*(daddy|mama|baby)|adult\s*(service|fun|meet))\b/i,
  /\b(available\s*for\s*(hire|booking)|book\s*me|hire\s*me)\b/i,
];

const MODERATE_BLOCK_NORMALIZED = [
  /whatsapp/, /telegram/, /instagram/, /snapchat/,
  /[6-9]\d{9}/,
  /\b\d{10,}\b/,
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2D — LEVEL 3: SEVERE BLOCK PATTERNS
// Reject + 1 strike + immediate 7-day suspension.
// ═══════════════════════════════════════════════════════════════════════════════

const SEVERE_BLOCK_ORIGINAL = [
  /\bfor\s*sex\b/i,
  /\bsex\s*(available|meet|chat|friend|partner|service|work)\b/i,
  /\bavailable\s*for\s*sex\b/i,
  /\b(playboy|play\s*boy|gigolo|call\s*girl|escort)\b/i,
  /\bone\s*night\s*stand\b/i,
  /\b(kill\s*(my)?self|want\s*to\s*die|end\s*(my\s*)?life|commit\s*suicide)\b/i,
  /\b(i\s*will\s*kill|i\s*will\s*hurt|i\s*will\s*find\s*you)\b/i,
  /\b(rape|molestation|child\s*(sex|abuse|porn))\b/i,
];

const SEVERE_BLOCK_NORMALIZED = [
  /playboy/, /gigolo/, /callgirl/, /escort/,
  /forsex/, /sexavailable/, /availableforsex/,
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3 — OPENAI MODERATION (single batched call)
// ═══════════════════════════════════════════════════════════════════════════════

async function checkWithOpenAI(fieldTexts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production')
      console.error('[MODERATION] ❌ OPENAI_API_KEY missing — AI layer disabled');
    return { safe: true, flaggedCategories: [], maxLevel: LEVEL.AUTO_CLEAN };
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

    const result   = res.data.results[0];
    const scores   = result.category_scores;
    const flagged  = [];
    let   maxLevel = LEVEL.AUTO_CLEAN;

    for (const [cat, threshold] of Object.entries(OPENAI_THRESHOLDS)) {
      if ((scores[cat] ?? 0) >= threshold) {
        flagged.push(cat);
        const catLevel = AI_CATEGORY_LEVEL[cat] ?? LEVEL.MODERATE;
        if (catLevel > maxLevel) maxLevel = catLevel;
      }
    }
    return { safe: flagged.length === 0, flaggedCategories: flagged, maxLevel };

  } catch (err) {
    const status = err.response?.status;
    if (status === 401) console.error('[MODERATION] ❌ Invalid OPENAI_API_KEY');
    else if (status === 429) console.warn('[MODERATION] ⚠️ OpenAI rate limit — skipping AI layer');
    else console.error('[MODERATION] OpenAI unavailable (fail-open):', err.message);
    return { safe: true, flaggedCategories: [], maxLevel: LEVEL.AUTO_CLEAN };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGEX CLASSIFIER — returns highest level found for a single text
// ═══════════════════════════════════════════════════════════════════════════════

function classifyText(original, normalized) {
  for (const p of SEVERE_BLOCK_ORIGINAL)    { if (p.test(original))   return { level: LEVEL.SEVERE,   reason: 'severe_content'   }; }
  for (const p of SEVERE_BLOCK_NORMALIZED)   { if (p.test(normalized))  return { level: LEVEL.SEVERE,   reason: 'severe_bypass'    }; }
  for (const p of HATE_SPEECH_PATTERNS)      { if (p.test(original))   return { level: LEVEL.SEVERE,   reason: 'hate_speech'      }; }
  for (const p of MODERATE_BLOCK_ORIGINAL)   { if (p.test(original))   return { level: LEVEL.MODERATE,  reason: 'moderate_solicitation' }; }
  for (const p of MODERATE_BLOCK_NORMALIZED) { if (p.test(normalized))  return { level: LEVEL.MODERATE,  reason: 'moderate_bypass'  }; }
  for (const p of SOFT_BLOCK_PATTERNS)       { if (p.test(original))   return { level: LEVEL.SOFT,      reason: 'soft_suggestive'  }; }
  return { level: LEVEL.AUTO_CLEAN, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER-FACING MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

function getUserMessage(level, reason, aiCategories = []) {
  switch (level) {
    case LEVEL.AUTO_CLEAN:
      return 'Some contact information was automatically removed from your text.';
    case LEVEL.SOFT:
      return 'Please keep your content genuine and appropriate. Suggestive phrases are not allowed.';
    case LEVEL.MODERATE:
      if (reason?.includes('solicitation') || reason?.includes('bypass'))
        return "Contact-sharing and solicitation patterns aren't allowed on Humrah.";
      if (aiCategories.some(c => c.startsWith('harassment')))
        return 'Harassment is not tolerated. Please keep interactions respectful.';
      return 'This content violates our community guidelines.';
    case LEVEL.SEVERE:
      if (reason === 'hate_speech')
        return 'Discriminatory content based on race, religion, caste, or skin colour is not allowed on Humrah.';
      if (aiCategories.some(c => c.startsWith('sexual')))   return 'Sexual content is strictly not allowed on Humrah.';
      if (aiCategories.some(c => c.startsWith('self-harm')))return "This content isn't allowed. Please reach out for support if you're struggling.";
      if (aiCategories.some(c => c.startsWith('hate')))     return 'Hate speech is not tolerated on Humrah.';
      return 'This content severely violates our community guidelines and has been flagged for review.';
    default:
      return "This content doesn't meet our community guidelines.";
  }
}

function getAndroidCode(level) {
  return (['AUTO_CLEAN', 'SOFT_BLOCK', 'MODERATE_BLOCK', 'SEVERE_BLOCK'])[level] || 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRIKE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Count active (non-expired) strikes.
 * Skips auto_clean and soft violations — they never count as strikes.
 * Returns 0 if user has been clean for CLEAN_RESET_DAYS.
 */
function getActiveStrikeCount(moderationFlags) {
  if (!moderationFlags) return 0;

  const now          = Date.now();
  const expiryMs     = STRIKE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const cleanResetMs = CLEAN_RESET_DAYS   * 24 * 60 * 60 * 1000;

  if (moderationFlags.lastViolationAt) {
    const sinceViolation = now - new Date(moderationFlags.lastViolationAt).getTime();
    if (sinceViolation > cleanResetMs) return 0;  // full reset
  }

  return (moderationFlags.violations || []).filter(v => {
    if (!v.level || v.level <= LEVEL.SOFT) return false;     // soft/clean = no strike
    const age = now - new Date(v.detectedAt).getTime();
    return age <= expiryMs;
  }).length;
}

function resolveStrikeAction(newStrikeCount) {
  const rule = STRIKE_RULES[Math.min(newStrikeCount, 4)];
  if (!rule) return null;
  return {
    action:       rule.action,
    suspendUntil: rule.duration ? new Date(Date.now() + rule.duration * 60 * 60 * 1000) : null,
    message:      rule.message,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE: moderateQuestionnaire
// Profile text fields: bio, goodMeetupMeaning, vibeQuote
// ═══════════════════════════════════════════════════════════════════════════════

async function moderateQuestionnaire(questionnaire) {
  const errors           = [];      // fields to reject (shown to user)
  const violations       = [];      // all issues for DB logging
  const autoCleanedFields = [];     // fields where only auto-clean happened
  const cleaned          = { ...questionnaire };
  const textsForAI       = {};
  let   maxLevel         = LEVEL.AUTO_CLEAN;

  for (const field of MODERATED_TEXT_FIELDS) {
    const raw = questionnaire[field];
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const normalized  = normalizeText(trimmed);
    const { level: regexLevel, reason } = classifyText(trimmed, normalized);

    if (regexLevel >= LEVEL.MODERATE) {
      // Hard reject — wipe field, record violation
      cleaned[field] = '';
      if (regexLevel > maxLevel) maxLevel = regexLevel;
      violations.push({ field, level: regexLevel, reason, originalValue: trimmed });
      errors.push({ field, code: getAndroidCode(regexLevel), level: regexLevel, message: getUserMessage(regexLevel, reason) });
      continue;
    }

    if (regexLevel === LEVEL.SOFT) {
      // Soft reject — don't save, no strike, warn only
      cleaned[field] = '';
      if (LEVEL.SOFT > maxLevel) maxLevel = LEVEL.SOFT;
      violations.push({ field, level: LEVEL.SOFT, reason, originalValue: trimmed });
      errors.push({ field, code: 'SOFT_BLOCK', level: LEVEL.SOFT, message: getUserMessage(LEVEL.SOFT, reason) });
      continue;
    }

    // Auto-clean pass
    const autoCleaned = autoCleanText(trimmed);
    if (autoCleaned !== trimmed) {
      violations.push({ field, level: LEVEL.AUTO_CLEAN, reason: 'auto_cleaned', originalValue: trimmed, cleanedValue: autoCleaned });
      autoCleanedFields.push(field);
    }
    cleaned[field] = autoCleaned;

    // Queue for AI if long enough and not already rejected
    if (normalizeText(autoCleaned).length >= MIN_LENGTH_FOR_AI) {
      textsForAI[field] = normalizeText(autoCleaned);
    }
  }

  // Single batched OpenAI call for all surviving fields
  if (Object.keys(textsForAI).length > 0) {
    const ai = await checkWithOpenAI(textsForAI);
    if (!ai.safe) {
      if (ai.maxLevel > maxLevel) maxLevel = ai.maxLevel;
      const msg = getUserMessage(ai.maxLevel, 'ai_flagged', ai.flaggedCategories);
      for (const field of Object.keys(textsForAI)) {
        cleaned[field] = '';
        violations.push({ field, level: ai.maxLevel, reason: 'ai_flagged', categories: ai.flaggedCategories, originalValue: questionnaire[field]?.trim() || '' });
        errors.push({ field, code: getAndroidCode(ai.maxLevel), level: ai.maxLevel, categories: ai.flaggedCategories, message: msg });
      }
    }
  }

  return { cleanedQuestionnaire: cleaned, violations, errors, maxLevel, autoCleanedFields };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE: moderateChatMessage
// Used by message route. Returns result — route handles optimistic UI via socket.
// ═══════════════════════════════════════════════════════════════════════════════

async function moderateChatMessage(messageText) {
  const empty = { allowed: true, cleanedText: '', level: -1, reason: null, autoCleanOnly: false, violations: [], userMessage: null };
  if (!messageText || typeof messageText !== 'string') return empty;

  const trimmed     = messageText.trim();
  const normalized  = normalizeText(trimmed);
  const autoCleaned = autoCleanText(trimmed);

  const { level: regexLevel, reason } = classifyText(trimmed, normalized);

  // Hard reject (MODERATE or SEVERE)
  if (regexLevel >= LEVEL.MODERATE) {
    return {
      allowed: false, cleanedText: '', level: regexLevel, reason,
      autoCleanOnly: false,
      violations: [{ level: regexLevel, reason, originalValue: trimmed }],
      userMessage: getUserMessage(regexLevel, reason),
    };
  }

  // Soft reject
  if (regexLevel === LEVEL.SOFT) {
    return {
      allowed: false, cleanedText: '', level: LEVEL.SOFT, reason,
      autoCleanOnly: false,
      violations: [{ level: LEVEL.SOFT, reason, originalValue: trimmed }],
      userMessage: getUserMessage(LEVEL.SOFT, reason),
    };
  }

  // AI check on auto-cleaned text
  const cleanedForAI = normalizeText(autoCleaned);
  if (cleanedForAI.length >= MIN_LENGTH_FOR_AI) {
    const ai = await checkWithOpenAI({ message: cleanedForAI });
    if (!ai.safe) {
      return {
        allowed: false, cleanedText: '', level: ai.maxLevel, reason: 'ai_flagged',
        autoCleanOnly: false,
        violations: [{ level: ai.maxLevel, reason: 'ai_flagged', categories: ai.flaggedCategories, originalValue: trimmed }],
        userMessage: getUserMessage(ai.maxLevel, 'ai_flagged', ai.flaggedCategories),
      };
    }
  }

  // Passed — return auto-cleaned text
  const wasModified = autoCleaned !== trimmed;
  return {
    allowed:       true,
    cleanedText:   autoCleaned,
    level:         wasModified ? LEVEL.AUTO_CLEAN : -1,
    reason:        wasModified ? 'auto_cleaned' : null,
    autoCleanOnly: wasModified,
    violations:    wasModified ? [{ level: LEVEL.AUTO_CLEAN, reason: 'auto_cleaned', originalValue: trimmed, cleanedValue: autoCleaned }] : [],
    userMessage:   wasModified ? getUserMessage(LEVEL.AUTO_CLEAN) : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRIKE ENFORCER: applyStrikesAndEnforce
// Call after any moderation pipeline. Mutates user, saves, returns action taken.
// ═══════════════════════════════════════════════════════════════════════════════

async function applyStrikesAndEnforce(user, violations, route) {
  if (!violations?.length) return { enforced: false, action: null, message: null, suspendUntil: null };

  if (!user.moderationFlags) user.moderationFlags = { isFlagged: false, strikeCount: 0, violations: [] };

  // Log all violations to history
  for (const v of violations) {
    user.moderationFlags.violations.push({
      field:         v.field || 'message',
      level:         v.level,
      reason:        v.reason,
      originalValue: v.originalValue ? v.originalValue.substring(0, 300) : '',
      cleanedValue:  v.cleanedValue  ? v.cleanedValue.substring(0, 300)  : '',
      categories:    v.categories || [],
      detectedAt:    new Date(),
      route:         route || 'unknown',
    });
  }
  if (user.moderationFlags.violations.length > 100) {
    user.moderationFlags.violations = user.moderationFlags.violations.slice(-100);
  }

  const strikeViolations = violations.filter(v => v.level >= LEVEL.MODERATE);
  const softViolations   = violations.filter(v => v.level === LEVEL.SOFT);

  let enforced     = false;
  let action       = null;
  let message      = null;
  let suspendUntil = null;

  if (strikeViolations.length > 0) {
    const hasSevere      = strikeViolations.some(v => v.level === LEVEL.SEVERE);
    const currentStrikes = getActiveStrikeCount(user.moderationFlags);
    const newStrikeCount = currentStrikes + strikeViolations.length;

    if (hasSevere && user.status === 'ACTIVE') {
      // Severe = immediate 7-day suspension, bypass normal escalation
      suspendUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      action = 'suspend'; message = STRIKE_RULES[3].message; enforced = true;
      user.status = 'SUSPENDED';
      user.suspensionInfo = {
        isSuspended: true, suspensionReason: 'Severe content violation (auto-detected)',
        suspendedAt: new Date(), suspendedUntil: suspendUntil,
        restrictions: ['chat', 'booking', 'profile_edit'],
      };
      console.log(`[MODERATION] 🚨 SEVERE — User ${user._id} auto-suspended 7 days`);

    } else {
      const enforcement = resolveStrikeAction(newStrikeCount);
      if (enforcement) {
        action = enforcement.action; message = enforcement.message; enforced = true;

        if (enforcement.action === 'restrict') {
          // Chat-only restriction — account stays ACTIVE
          suspendUntil = enforcement.suspendUntil;
          if (!user.suspensionInfo) user.suspensionInfo = {};
          user.suspensionInfo.restrictions          = ['chat'];
          user.suspensionInfo.chatRestrictedUntil   = suspendUntil;
          console.log(`[MODERATION] ⚠️ User ${user._id} chat-restricted 24h`);

        } else if (enforcement.action === 'suspend') {
          suspendUntil = enforcement.suspendUntil;
          user.status = 'SUSPENDED';
          user.suspensionInfo = {
            isSuspended: true, suspensionReason: 'Repeated violations (auto-detected)',
            suspendedAt: new Date(), suspendedUntil: suspendUntil,
            restrictions: ['chat', 'booking', 'profile_edit'],
          };
          console.log(`[MODERATION] 🔴 User ${user._id} suspended (strike ${newStrikeCount})`);

        } else if (enforcement.action === 'ban') {
          user.status = 'BANNED';
          user.banInfo = { isBanned: true, banReason: 'Exceeded violation limit (auto-detected)', bannedAt: new Date(), isPermanent: true };
          console.log(`[MODERATION] 🚫 User ${user._id} PERMANENTLY BANNED (strike ${newStrikeCount})`);
        }
      }
    }

    user.moderationFlags.isFlagged       = true;
    user.moderationFlags.strikeCount     = newStrikeCount;
    user.moderationFlags.lastViolationAt = new Date();

  } else if (softViolations.length > 0) {
    user.moderationFlags.isFlagged       = true;
    user.moderationFlags.lastViolationAt = new Date();
    action = 'warning'; message = getUserMessage(LEVEL.SOFT); enforced = true;
  }

  user.markModified('moderationFlags');
  await user.save();

  return { enforced, action, message, suspendUntil };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 422 rejection response — Android reads errors[] and enforcement{}
 * Example Android handling:
 *   if (code == 422 && body.code == "MODERATION_FAILED") {
 *     body.errors.forEach { showErrorUnderField(it.field, it.message) }
 *     if (body.enforcement?.action == "suspend") showSuspendedDialog(body.enforcement.message)
 *   }
 */
function buildModerationResponse(errors, enforcement, autoCleanWarnings = []) {
  return {
    success:  false,
    code:     'MODERATION_FAILED',
    message:  'Some content violates our community guidelines.',
    errors,
    enforcement: enforcement.enforced ? {
      action:       enforcement.action,
      message:      enforcement.message,
      suspendUntil: enforcement.suspendUntil?.toISOString() || null,
    } : null,
    autoCleanWarnings,
  };
}

/**
 * 200 success but with auto-clean warnings.
 * Android shows inline hint: "Some contact info was removed"
 */
function buildAutoCleanSuccessResponse(autoCleanedFields) {
  return {
    success:  true,
    warnings: autoCleanedFields.map(field => ({
      field,
      code:    'AUTO_CLEANED',
      message: 'Some contact information was automatically removed from this field.',
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  moderateQuestionnaire,
  moderateChatMessage,
  applyStrikesAndEnforce,
  getActiveStrikeCount,
  buildModerationResponse,
  buildAutoCleanSuccessResponse,
  LEVEL,
  MODERATED_TEXT_FIELDS,
};
