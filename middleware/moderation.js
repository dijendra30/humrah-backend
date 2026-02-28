// middleware/moderation.js  v3
// ─────────────────────────────────────────────────────────────────────────────
// HUMRAH MODERATION ENGINE — Production-Ready 5-Level System
//
// LEVEL 0 — Clean          → Save normally, no logging
// LEVEL 1 — Minor Soft     → Warn, allow/soft-block, NO strike; 3 repeats = 1 strike
// LEVEL 2 — Policy         → Block + strike + escalating cooldowns/suspensions
// LEVEL 3 — Harassment     → Block + direct suspension, escalating
// LEVEL 4 — Zero Tolerance → Immediate 7-day; confirmed severe = permanent ban
//
// STRIKE SYSTEM:
//   Strikes expire after 90 days of clean behavior (full reset)
//   Per-category offense counters drive escalation independently:
//     L2 offenses: 1st → 24h edit lock | 2nd → 3d suspend | 3rd → 7d suspend | 5 total → ban
//     L3 offenses: 1st → 3d suspend    | 2nd → 7d suspend  | 3rd → ban
//     L4 offenses: 1st → 7d suspend    | confirmed severe  → permanent ban
//
// COOLDOWN LOCKS (fit punishment to violation):
//   profile_edit  — cannot edit bio/profile fields
//   chat          — cannot send messages
//   companion     — companion mode suspended
//   earnings      — payouts frozen
//
// USER MESSAGES: Professional. Neutral. Firm.
//   Never: "You are toxic."  Always: "Your content violates our community guidelines."
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const axios = require('axios');

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MODERATED_TEXT_FIELDS = ['bio', 'goodMeetupMeaning', 'vibeQuote'];
const MIN_LENGTH_FOR_AI     = 15;
const CLEAN_RESET_DAYS      = 90;
const CLEAN_RESET_MS        = CLEAN_RESET_DAYS * 24 * 60 * 60 * 1000;

const LEVEL = Object.freeze({
  CLEAN     : 0,
  SOFT      : 1,
  POLICY    : 2,
  HARASSMENT: 3,
  ZERO_TOL  : 4,
});

// ── L2 Policy escalation by offense count ─────────────────────────────────────
const L2_ESCALATION = Object.freeze({
  1: { action: 'cooldown', restrictions: ['profile_edit'],                                       durationHours: 24,   message: 'Your profile editing has been locked for 24 hours due to a policy violation.' },
  2: { action: 'suspend',  restrictions: ['chat', 'profile_edit', 'companion'],                  durationHours: 72,   message: 'Your account has been suspended for 3 days due to a repeat policy violation.' },
  3: { action: 'suspend',  restrictions: ['chat', 'profile_edit', 'companion', 'earnings'],      durationHours: 168,  message: 'Your account has been suspended for 7 days due to repeated policy violations.' },
});

// ── L3 Harassment escalation by offense count ─────────────────────────────────
const L3_ESCALATION = Object.freeze({
  1: { action: 'suspend',  restrictions: ['chat', 'profile_edit'],                               durationHours: 72,   message: 'Your account has been suspended for 3 days due to a harassment violation.' },
  2: { action: 'suspend',  restrictions: ['chat', 'profile_edit', 'companion', 'earnings'],      durationHours: 168,  message: 'Your account has been suspended for 7 days due to repeated harassment.' },
  3: { action: 'ban',      restrictions: [],                                                      durationHours: null, message: 'Your account has been permanently banned due to repeated harassment violations.' },
});

// ── L4 Zero Tolerance — always immediate ──────────────────────────────────────
const L4_IMMEDIATE = Object.freeze({
  initial:   { action: 'suspend', restrictions: ['chat', 'profile_edit', 'companion', 'earnings'], durationHours: 168,  message: 'Your account has been suspended for 7 days. This content violates our zero-tolerance policy.' },
  confirmed: { action: 'ban',     restrictions: [],                                                 durationHours: null, message: 'Your account has been permanently banned for a severe zero-tolerance violation.' },
});

// ── OpenAI category → violation level ─────────────────────────────────────────
const AI_CATEGORY_LEVEL = {
  'sexual/minors':          LEVEL.ZERO_TOL,
  'hate':                   LEVEL.ZERO_TOL,
  'hate/threatening':       LEVEL.ZERO_TOL,
  'violence/graphic':       LEVEL.ZERO_TOL,
  'harassment/threatening': LEVEL.HARASSMENT,
  'harassment':             LEVEL.HARASSMENT,
  'self-harm/intent':       LEVEL.HARASSMENT,
  'self-harm/instructions': LEVEL.HARASSMENT,
  'sexual':                 LEVEL.POLICY,
  'self-harm':              LEVEL.POLICY,
  'violence':               LEVEL.POLICY,
};

const OPENAI_THRESHOLDS = {
  'sexual':                  0.40,
  'sexual/minors':           0.01,
  'harassment':              0.45,
  'harassment/threatening':  0.25,
  'hate':                    0.20,
  'hate/threatening':        0.15,
  'violence':                0.65,
  'violence/graphic':        0.35,
  'self-harm':               0.30,
  'self-harm/intent':        0.10,
  'self-harm/instructions':  0.10,
};

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 — TEXT NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const LEET_MAP = { '@':'a','4':'a','3':'e','1':'i','!':'i','0':'o','5':'s','$':'s','7':'t','+':'t','8':'b','6':'g','9':'g' };

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
// ═══════════════════════════════════════════════════════════════════════════════

const AUTO_CLEAN_PATTERNS = [
  /(?:(?:\+|00)?91[\s\-.]?)?[6-9]\d{9}/g,
  /\b[6-9]([\s.\-]{1,3}\d){9}\b/g,
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
// LAYER 2B — LEVEL 1: SOFT / MINOR PATTERNS
// Mild rudeness, borderline tone, light non-targeted profanity.
// No immediate strike. 3 soft offenses = 1 strike (tracked in DB).
// ═══════════════════════════════════════════════════════════════════════════════

const SOFT_PATTERNS = [
  /\b(no\s+idiots?|don'?t\s+be\s+boring|boring\s+people\s+stay\s+away)\b/i,
  /\b(losers?\s+(not\s+welcome|stay\s+away)|only\s+serious\s+people)\b/i,
  /\b(hot\s*guy|hot\s*girl|sexy\s*(?:time|fun|vibes?)|flirt(?:y|ing)?)\b/i,
  /\b(looking\s*for\s*(?:fun|timepass|tp|good\s*time))\b/i,
  /\b(no\s*strings|casual\s*(?:meet|fun|hangout|relation))\b/i,
  /\b(open\s*minded\s*(?:guy|girl|person|meet))\b/i,
  /\b(wtf|damn|crap|bloody\s+hell|shut\s+up)\b/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2C — LEVEL 2: POLICY VIOLATION PATTERNS
// Solicitation, contact-sharing, booking/pricing.
// ═══════════════════════════════════════════════════════════════════════════════

const POLICY_PATTERNS_ORIGINAL = [
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me)\b/i,
  /\b(reach\s*(?:me|out)|hit\s*me\s*up|ping\s*me|slide\s*in(?:to)?\s*(?:my|the))\b/i,
  /\b(my\s*(?:number|no\.?|num|contact|handle|id)\s*(?:is|:))/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,
  /\b(hookup|hook\s*up|nsa|fwb|friends?\s*with\s*benefits)\b/i,
  /\b(paid\s*(?:service|meet|session|companion|friend)|rate\s*card)\b/i,
  /\b(sugar\s*(?:daddy|mama|baby)|adult\s*(?:service|fun|meet))\b/i,
  /\b(available\s*for\s*(?:hire|booking)|book\s*me|hire\s*me|dm\s*me\s*for\s*rates?)\b/i,
];

const POLICY_PATTERNS_NORMALIZED = [
  /whatsapp/, /telegram/, /instagram/, /snapchat/,
  /[6-9]\d{9}/, /\b\d{10,}\b/,
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2D — LEVEL 3: HARASSMENT PATTERNS
// Targeted threats, personal attacks, abuse toward a person.
// ═══════════════════════════════════════════════════════════════════════════════

const HARASSMENT_PATTERNS = [
  /\b(i\s*will\s*(?:find|hurt|kill|destroy|ruin)\s*you)\b/i,
  /\b(you'?re?\s*(?:worthless|pathetic|disgusting|a\s*loser|garbage|trash|scum))\b/i,
  /\b(go\s*(?:kill\s*yourself|die|hang\s*yourself))\b/i,
  /\b(i\s*know\s*where\s*you\s*(?:live|are|work))\b/i,
  /\b(watch\s*your\s*back|you\s*(?:will|won'?t)\s*get\s*away)\b/i,
  /\b(you\s*are\s*(?:a\s*)?(?:bitch|whore|slut|bastard|asshole|idiot|moron))\b/i,
  /\b(nobody\s*(?:likes|loves|cares\s*about)\s*you)\b/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2E — LEVEL 4: ZERO TOLERANCE PATTERNS
// Hate speech / CSA / extremism / sexual exploitation / violence incitement.
// ═══════════════════════════════════════════════════════════════════════════════

const ZERO_TOL_PATTERNS = [
  // Racial hate
  /\bhate\s+(black|white|brown|asian|african|arab|jewish|muslim|hindu|sikh|christian)\s+(people|person|men|women|girls|guys|community)\b/i,
  /\b(black|white|brown|asian|african|arab|jewish|muslim|hindu|sikh)\s+people\s+(are|r)\s+(not\s+welcome|not\s+allowed|disgusting|dirty|inferior|ugly|stupid|criminals?|terrorists?|filthy)\b/i,
  /\bno\s+(black|white|brown|asian|african|arab|jewish|muslim|hindu|sikh|dalit|lower\s*caste)\s+(people|person|allowed|welcome|here|pls|please)\b/i,
  /\bonly\s+(fair|light\s*skin|white|upper\s*caste|hindu|muslim)\s+(people|person|allowed|welcome|connect)\b/i,
  /\b(blacks?|whiteys?|brownies?)\s+(not\s+welcome|stay\s+away|don'?t\s+connect|please\s+don'?t)\b/i,
  /\balways\s+(be\s+)?happy\s+with\s+(white|fair|light)\b/i,
  /\bno\s+(minorities|untouchables?|refugees?|foreigners?|outsiders?)\b/i,
  // Caste discrimination
  /\b(upper|lower)\s+caste\s+(only|not\s+welcome|stay\s+away|preferred|not\s+allowed)\b/i,
  /\b(brahmin|kshatriya|vaishya|shudra|dalit|obc|sc|st)\s+(only|not\s+welcome|not\s+allowed|stay\s+away)\b/i,
  /\bno\s+(dalit|sc|st|obc|lower\s*caste)\b/i,
  /\bcasteist\b/i,
  // Religious hate
  /\bhate\s+(muslim|hindu|christian|sikh|jewish|buddhist|jain|parsi)s?\b/i,
  /\b(muslims?|hindus?|christians?|sikhs?|jews?)\s+(not\s+welcome|not\s+allowed|stay\s+away|are\s+(?:terrorists?|criminals?|evil|bad\s+people))\b/i,
  // Skin tone discrimination
  /\b(only|prefer|no)\s+(fair|dark|dusky|wheatish)\s+(skin|people|girls|guys|person)\b/i,
  /\b(dark\s*skin|black\s*skin)\s+(not\s+welcome|stay\s+away|not\s+my\s+type|disgusting)\b/i,
  // Sexual exploitation
  /\bfor\s*sex\b/i,
  /\bsex\s*(available|meet|chat|friend|partner|service|work)\b/i,
  /\bavailable\s*for\s*sex\b/i,
  /\b(playboy|play\s*boy|gigolo|call\s*girl|escort)\b/i,
  /\bone\s*night\s*stand\b/i,
  // CSA
  /\b(child\s*(?:sex|abuse|porn)|minor\s*(?:sex|exploit)|csa)\b/i,
  /\b(rape|molestation)\b/i,
  // Extremism / violence incitement
  /\b(join\s*(?:this|our|the)\s*(?:jihad|extremist|terrorist|isis|al.?qaeda))\b/i,
  /\b(let'?s\s*(?:hurt|attack|bomb|kill)\s*(?:them|those|the))\b/i,
  /\b(kill\s*all\s*(?:muslims?|hindus?|christians?|jews?|blacks?|whites?))\b/i,
  /\b(suicide\s*bomb|blow\s*up|mass\s*shooting)\b/i,
  // Severe self-harm
  /\b(kill\s*(?:my)?self|want\s*to\s*die|end\s*(?:my\s*)?life|commit\s*suicide)\b/i,
];

const ZERO_TOL_NORMALIZED = [
  /playboy/, /gigolo/, /callgirl/, /escort/,
  /forsex/, /sexavailable/, /availableforsex/,
];

// ═══════════════════════════════════════════════════════════════════════════════
// OPENAI MODERATION LAYER
// ═══════════════════════════════════════════════════════════════════════════════

async function checkWithOpenAI(fieldTexts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production')
      console.error('[MODERATION] OPENAI_API_KEY missing — AI layer disabled');
    return { safe: true, flaggedCategories: [], maxLevel: LEVEL.CLEAN };
  }

  const input = Object.entries(fieldTexts).map(([f, t]) => `[${f}]: ${t}`).join('\n---\n');

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/moderations',
      { input },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 6000 }
    );

    const scores  = res.data.results[0].category_scores;
    const flagged = [];
    let maxLevel  = LEVEL.CLEAN;

    for (const [cat, threshold] of Object.entries(OPENAI_THRESHOLDS)) {
      if ((scores[cat] ?? 0) >= threshold) {
        flagged.push(cat);
        const catLevel = AI_CATEGORY_LEVEL[cat] ?? LEVEL.POLICY;
        if (catLevel > maxLevel) maxLevel = catLevel;
      }
    }
    return { safe: flagged.length === 0, flaggedCategories: flagged, maxLevel };

  } catch (err) {
    const status = err.response?.status;
    if (status === 401) console.error('[MODERATION] Invalid OPENAI_API_KEY');
    else if (status === 429) console.warn('[MODERATION] OpenAI rate limit — skipping AI layer');
    else console.error('[MODERATION] OpenAI unavailable (fail-open):', err.message);
    return { safe: true, flaggedCategories: [], maxLevel: LEVEL.CLEAN };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGEX CLASSIFIER
// ═══════════════════════════════════════════════════════════════════════════════

function classifyText(original, normalized) {
  for (const p of ZERO_TOL_PATTERNS)         { if (p.test(original))   return { level: LEVEL.ZERO_TOL,   reason: 'zero_tolerance'        }; }
  for (const p of ZERO_TOL_NORMALIZED)        { if (p.test(normalized))  return { level: LEVEL.ZERO_TOL,   reason: 'zero_tolerance_bypass' }; }
  for (const p of HARASSMENT_PATTERNS)        { if (p.test(original))   return { level: LEVEL.HARASSMENT,  reason: 'targeted_harassment'   }; }
  for (const p of POLICY_PATTERNS_ORIGINAL)   { if (p.test(original))   return { level: LEVEL.POLICY,      reason: 'policy_solicitation'   }; }
  for (const p of POLICY_PATTERNS_NORMALIZED) { if (p.test(normalized))  return { level: LEVEL.POLICY,      reason: 'policy_bypass'         }; }
  for (const p of SOFT_PATTERNS)              { if (p.test(original))   return { level: LEVEL.SOFT,        reason: 'minor_violation'       }; }
  return { level: LEVEL.CLEAN, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER-FACING MESSAGES — Professional. Neutral. Firm.
// ═══════════════════════════════════════════════════════════════════════════════

function getUserMessage(level, reason, aiCategories = []) {
  switch (level) {
    case LEVEL.CLEAN:
      return 'Some contact information was automatically removed from your profile.';

    case LEVEL.SOFT:
      return 'Your content has been flagged for inappropriate tone. Please keep your profile respectful and welcoming to all users.';

    case LEVEL.POLICY:
      if (aiCategories.some(c => c.startsWith('sexual')))
        return 'Your content violates our community guidelines. Sexual content is not permitted on Humrah.';
      return 'Your content violates our community guidelines. Please avoid contact-sharing or solicitation.';

    case LEVEL.HARASSMENT:
      if (aiCategories.some(c => c.startsWith('self-harm')))
        return 'Your content violates our community guidelines. Content that may endanger wellbeing is not permitted.';
      return 'Your content violates our community guidelines. Threatening or abusive content directed at others is not permitted.';

    case LEVEL.ZERO_TOL:
      if (aiCategories.some(c => c.includes('minors')))
        return 'Your content violates our zero-tolerance policy regarding the safety of minors.';
      if (aiCategories.some(c => c.startsWith('hate')))
        return 'Your content violates our zero-tolerance policy. Hate speech is strictly prohibited on Humrah.';
      return 'Your content violates our zero-tolerance policy. Discriminatory, exploitative, or extremist content is strictly prohibited on Humrah.';

    default:
      return 'Your content violates our community guidelines. Please review our policies before resubmitting.';
  }
}

function getAndroidCode(level) {
  return ([ 'AUTO_CLEAN', 'SOFT_BLOCK', 'POLICY_BLOCK', 'HARASSMENT_BLOCK', 'ZERO_TOL_BLOCK' ])[level] || 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFENSE COUNTER
// Per-category counts — each level escalates independently.
// Full reset after 90 days clean.
// ═══════════════════════════════════════════════════════════════════════════════

function getOffenseCounts(moderationFlags) {
  if (!moderationFlags) return { total: 0, l2: 0, l3: 0, l4: 0, soft: 0 };

  const now = Date.now();

  if (moderationFlags.lastViolationAt) {
    const sinceLast = now - new Date(moderationFlags.lastViolationAt).getTime();
    if (sinceLast > CLEAN_RESET_MS) return { total: 0, l2: 0, l3: 0, l4: 0, soft: 0 };
  }

  const counts = { total: 0, l2: 0, l3: 0, l4: 0, soft: 0 };
  for (const v of (moderationFlags.violations || [])) {
    const age = now - new Date(v.detectedAt).getTime();
    if (age > CLEAN_RESET_MS) continue;
    if (v.level === LEVEL.SOFT)       counts.soft++;
    if (v.level === LEVEL.POLICY)   { counts.l2++;  counts.total++; }
    if (v.level === LEVEL.HARASSMENT){ counts.l3++;  counts.total++; }
    if (v.level === LEVEL.ZERO_TOL) { counts.l4++;  counts.total++; }
  }
  return counts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENFORCEMENT RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

function resolveEnforcement(violationLevel, { newL2Count, newL3Count, newL4Count, totalStrikes }) {
  // 5+ total strikes across any category → permanent ban
  if (totalStrikes >= 5) {
    return { action: 'ban', restrictions: [], durationHours: null, message: 'Your account has been permanently banned due to repeated community guideline violations.' };
  }

  if (violationLevel === LEVEL.ZERO_TOL) {
    return newL4Count >= 2 ? L4_IMMEDIATE.confirmed : L4_IMMEDIATE.initial;
  }

  if (violationLevel === LEVEL.HARASSMENT) {
    return L3_ESCALATION[Math.min(newL3Count, 3)] || L3_ESCALATION[3];
  }

  if (violationLevel === LEVEL.POLICY) {
    return L2_ESCALATION[Math.min(newL2Count, 3)] || L2_ESCALATION[3];
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE: moderateQuestionnaire
// ═══════════════════════════════════════════════════════════════════════════════

async function moderateQuestionnaire(questionnaire) {
  const errors            = [];
  const violations        = [];
  const autoCleanedFields = [];
  const cleaned           = { ...questionnaire };
  const textsForAI        = {};
  let   maxLevel          = LEVEL.CLEAN;

  for (const field of MODERATED_TEXT_FIELDS) {
    const raw = questionnaire[field];
    if (!raw || typeof raw !== 'string') continue;
    const trimmed    = raw.trim();
    if (!trimmed) continue;

    const normalized           = normalizeText(trimmed);
    const { level, reason }    = classifyText(trimmed, normalized);

    if (level >= LEVEL.POLICY) {
      cleaned[field] = '';
      if (level > maxLevel) maxLevel = level;
      violations.push({ field, level, reason, originalValue: trimmed });
      errors.push({ field, code: getAndroidCode(level), level, message: getUserMessage(level, reason) });
      continue;
    }

    if (level === LEVEL.SOFT) {
      cleaned[field] = '';
      if (LEVEL.SOFT > maxLevel) maxLevel = LEVEL.SOFT;
      violations.push({ field, level: LEVEL.SOFT, reason, originalValue: trimmed });
      errors.push({ field, code: 'SOFT_BLOCK', level: LEVEL.SOFT, message: getUserMessage(LEVEL.SOFT, reason) });
      continue;
    }

    const autoCleaned = autoCleanText(trimmed);
    if (autoCleaned !== trimmed) {
      violations.push({ field, level: LEVEL.CLEAN, reason: 'auto_cleaned', originalValue: trimmed, cleanedValue: autoCleaned });
      autoCleanedFields.push(field);
    }
    cleaned[field] = autoCleaned;

    if (normalizeText(autoCleaned).length >= MIN_LENGTH_FOR_AI) {
      textsForAI[field] = normalizeText(autoCleaned);
    }
  }

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
// ═══════════════════════════════════════════════════════════════════════════════

async function moderateChatMessage(messageText) {
  const empty = { allowed: true, cleanedText: '', level: -1, reason: null, autoCleanOnly: false, violations: [], userMessage: null };
  if (!messageText || typeof messageText !== 'string') return empty;

  const trimmed           = messageText.trim();
  const normalized        = normalizeText(trimmed);
  const { level, reason } = classifyText(trimmed, normalized);

  if (level >= LEVEL.POLICY) {
    return { allowed: false, cleanedText: '', level, reason, autoCleanOnly: false,
      violations: [{ level, reason, originalValue: trimmed }],
      userMessage: getUserMessage(level, reason) };
  }

  if (level === LEVEL.SOFT) {
    return { allowed: false, cleanedText: '', level: LEVEL.SOFT, reason, autoCleanOnly: false,
      violations: [{ level: LEVEL.SOFT, reason, originalValue: trimmed }],
      userMessage: getUserMessage(LEVEL.SOFT, reason) };
  }

  const autoCleaned  = autoCleanText(trimmed);
  const cleanedForAI = normalizeText(autoCleaned);
  if (cleanedForAI.length >= MIN_LENGTH_FOR_AI) {
    const ai = await checkWithOpenAI({ message: cleanedForAI });
    if (!ai.safe) {
      return { allowed: false, cleanedText: '', level: ai.maxLevel, reason: 'ai_flagged', autoCleanOnly: false,
        violations: [{ level: ai.maxLevel, reason: 'ai_flagged', categories: ai.flaggedCategories, originalValue: trimmed }],
        userMessage: getUserMessage(ai.maxLevel, 'ai_flagged', ai.flaggedCategories) };
    }
  }

  const wasModified = autoCleaned !== trimmed;
  return {
    allowed:       true,
    cleanedText:   autoCleaned,
    level:         wasModified ? LEVEL.CLEAN : -1,
    reason:        wasModified ? 'auto_cleaned' : null,
    autoCleanOnly: wasModified,
    violations:    wasModified ? [{ level: LEVEL.CLEAN, reason: 'auto_cleaned', originalValue: trimmed, cleanedValue: autoCleaned }] : [],
    userMessage:   wasModified ? getUserMessage(LEVEL.CLEAN) : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRIKE ENFORCER: applyStrikesAndEnforce
// ═══════════════════════════════════════════════════════════════════════════════

async function applyStrikesAndEnforce(user, violations, route) {
  if (!violations?.length) return { enforced: false, action: null, message: null, suspendUntil: null, restrictions: [] };

  if (!user.moderationFlags) {
    user.moderationFlags = { isFlagged: false, strikeCount: 0, violations: [] };
  }

  // Log all violations
  for (const v of violations) {
    user.moderationFlags.violations.push({
      field:         v.field         || 'message',
      level:         v.level,
      reason:        v.reason,
      originalValue: v.originalValue ? v.originalValue.substring(0, 300) : '',
      cleanedValue:  v.cleanedValue  ? v.cleanedValue.substring(0, 300)  : '',
      categories:    v.categories    || [],
      detectedAt:    new Date(),
      route:         route           || 'unknown',
    });
  }
  if (user.moderationFlags.violations.length > 200) {
    user.moderationFlags.violations = user.moderationFlags.violations.slice(-200);
  }
  user.moderationFlags.lastViolationAt = new Date();

  const softViolations   = violations.filter(v => v.level === LEVEL.SOFT);
  const strikeViolations = violations.filter(v => v.level >= LEVEL.POLICY);

  let enforced     = false;
  let action       = null;
  let message      = null;
  let suspendUntil = null;
  let restrictions = [];

  // ── SOFT only — no immediate strike, track repeat count ────────────────────
  if (softViolations.length > 0 && strikeViolations.length === 0) {
    const counts     = getOffenseCounts(user.moderationFlags);
    const softCount  = counts.soft;

    user.moderationFlags.isFlagged = true;

    if (softCount > 0 && softCount % 3 === 0) {
      // Every 3 soft offenses → apply L2 offense #1 cooldown
      const enf = L2_ESCALATION[1];
      action       = enf.action;
      message      = 'You have received multiple minor violations. Your profile editing has been locked for 24 hours.';
      restrictions = enf.restrictions;
      suspendUntil = new Date(Date.now() + enf.durationHours * 60 * 60 * 1000);
      enforced     = true;
      user.suspensionInfo = {
        isSuspended:           false,
        suspensionReason:      'Repeated minor violations (auto-detected)',
        suspendedAt:           new Date(),
        suspendedUntil:        suspendUntil,
        restrictions,
        chatRestrictedUntil:   null,
      };
      console.log(`[MODERATION] User ${user._id} — ${softCount} soft offenses → 24h profile_edit lock`);
    } else {
      action   = 'warning';
      message  = getUserMessage(LEVEL.SOFT);
      enforced = true;
      console.log(`[MODERATION] User ${user._id} — soft warning (${softCount} total soft)`);
    }

    user.moderationFlags.strikeCount = getOffenseCounts(user.moderationFlags).total;
    user.markModified('moderationFlags');
    await user.save();
    return { enforced, action, message, suspendUntil, restrictions };
  }

  // ── POLICY / HARASSMENT / ZERO_TOL ────────────────────────────────────────
  if (strikeViolations.length > 0) {
    const counts           = getOffenseCounts(user.moderationFlags);
    const maxViolationLevel = Math.max(...strikeViolations.map(v => v.level));

    const enf = resolveEnforcement(maxViolationLevel, {
      newL2Count:   counts.l2,
      newL3Count:   counts.l3,
      newL4Count:   counts.l4,
      totalStrikes: counts.total,
    });

    if (enf) {
      action       = enf.action;
      message      = enf.message;
      restrictions = enf.restrictions || [];
      enforced     = true;

      if (enf.action === 'ban') {
        user.status  = 'BANNED';
        user.banInfo = { isBanned: true, banReason: 'Repeated community guideline violations (auto-detected)', bannedAt: new Date(), isPermanent: true };
        console.log(`[MODERATION] User ${user._id} PERMANENTLY BANNED (${counts.total} strikes, L${maxViolationLevel})`);

      } else if (enf.action === 'suspend') {
        suspendUntil = new Date(Date.now() + enf.durationHours * 60 * 60 * 1000);
        user.status  = 'SUSPENDED';
        user.suspensionInfo = {
          isSuspended:     true,
          suspensionReason: `Level ${maxViolationLevel} violation (auto-detected)`,
          suspendedAt:     new Date(),
          suspendedUntil:  suspendUntil,
          restrictions,
        };
        const days = enf.durationHours / 24;
        console.log(`[MODERATION] User ${user._id} suspended ${days}d (L${maxViolationLevel})`);

      } else if (enf.action === 'cooldown') {
        // Profile edit lock only — account remains ACTIVE
        suspendUntil = new Date(Date.now() + enf.durationHours * 60 * 60 * 1000);
        if (!user.suspensionInfo) user.suspensionInfo = {};
        user.suspensionInfo.restrictions             = restrictions;
        user.suspensionInfo.profileEditLockedUntil   = suspendUntil;
        console.log(`[MODERATION] User ${user._id} profile_edit locked 24h (L2 offense #${counts.l2})`);
      }
    }

    user.moderationFlags.isFlagged   = true;
    user.moderationFlags.strikeCount = counts.total;
  }

  user.markModified('moderationFlags');
  await user.save();
  return { enforced, action, message, suspendUntil, restrictions };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildModerationResponse(errors, enforcement, autoCleanWarnings = []) {
  return {
    success:  false,
    code:     'MODERATION_FAILED',
    message:  'Your content violates our community guidelines.',
    errors,
    enforcement: enforcement?.enforced ? {
      action:       enforcement.action,
      message:      enforcement.message,
      suspendUntil: enforcement.suspendUntil?.toISOString() || null,
      restrictions: enforcement.restrictions || [],
    } : null,
    autoCleanWarnings,
  };
}

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
  getOffenseCounts,
  buildModerationResponse,
  buildAutoCleanSuccessResponse,
  LEVEL,
  MODERATED_TEXT_FIELDS,
};
