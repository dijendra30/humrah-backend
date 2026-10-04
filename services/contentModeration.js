// services/contentModeration.js
// -----------------------------------------------------------------------------
// Content moderation for short user-generated text, in any context (Ask a Question
// now; answers and replies; later Rooms or Community). One entry point:
//
//   moderateUserText(text, { context }) → { verdict, reasonCode, abusive, userMessage }
//     verdict  SAFE     allow
//              BLOCKED  refuse; userMessage says why in general terms (never the word)
//              REVIEW   refuse for now and ask the user to rephrase
//     abusive  true only for abuse (profanity, harassment, hate, sexual, AI-flagged);
//              contact details, links and self-harm are never "abusive"
//
// It is built ON the existing engine (middleware/moderation.js v3): its classifier,
// normaliser and AI layer run through moderateChatMessage. On top it adds what user
// posts need and chat does not: contact details, links and handles are REFUSED (chat
// strips them), a profanity lexicon (English + romanised Hindi) with disguise
// handling, and Unicode lookalike folding.
//
// IT NEVER ENFORCES. No strike, restriction, suspension or ban happens here — it only
// returns a verdict. (applyStrikesAndEnforce is deliberately not used.) The text is
// never logged.
// -----------------------------------------------------------------------------
'use strict';

const engine = require('../middleware/moderation');

// ── Text normalisation (shared with validators) ─────────────────────────────

const INVISIBLE = /[​‌⁠﻿­᠎‎‏‪-‮⁦-⁩]/g;
// Controls (C0 except tab/newline/CR, DEL, C1)
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * The stored form of user text: NFC, invisible/bidi/control characters removed, a zero-width
 * joiner kept only inside emoji sequences, every newline/tab/space run → one space, trimmed.
 */
function sanitizeText(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.normalize('NFC').replace(CONTROL, '').replace(INVISIBLE, '');
  // ZWJ (U+200D): keep it only between two pictographs (family / profession emoji).
  t = t.replace(/‍/g, (m, i, s) => {
    const before = s.codePointAt(Math.max(0, i - 2)) || 0, after = s.codePointAt(i + 1) || 0;
    const pict = cp => /\p{Extended_Pictographic}/u.test(String.fromCodePoint(cp));
    return pict(before) && pict(after) ? m : '';
  });
  return t.replace(/\s+/gu, ' ').trim();
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
/** What a person counts as one character (an emoji, an accented letter): grapheme clusters. */
function graphemeLength(text) {
  if (!text) return 0;
  if (segmenter) { let n = 0; for (const _ of segmenter.segment(text)) n++; return n; }   // eslint-disable-line no-unused-vars
  return Array.from(text).length;
}
const letterCount = text => (text.match(/\p{L}/gu) || []).length;

// Cyrillic / Greek lookalikes → Latin (the common confusables), then NFKC folds full-width etc.
const CONFUSABLES = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'м': 'm', 'т': 't', 'н': 'h', 'в': 'b', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'ɡ': 'g',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'ν': 'v', 'κ': 'k', 'ι': 'i', 'χ': 'x',
};
function fold(text) {
  let t = text.normalize('NFKC').toLowerCase();
  t = t.replace(/[̀-ͯ]/g, '');
  t = t.replace(/./gu, c => CONFUSABLES[c] || c);
  return t.replace(INVISIBLE, '');
}

// ── Contact details, links, handles ─────────────────────────────────────────

const NUMBER_WORDS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ek: '1', do: '2', teen: '3', char: '4', chaar: '4', paanch: '5', panch: '5', chhe: '6', chhah: '6', saat: '7', aath: '8', nau: '9', shunya: '0' };
const TLDS = 'com|in|net|org|co|io|me|xyz|app|info|biz|ly|gg|link|site|online|shop|store|tv|us|uk|live|club|page|ai|dev|tk|ml|ga|cf';

const URL_PATTERNS = [
  /\b(?:https?|hxxps?|ftp)\s*:\s*\/\//i,
  /\b(?:https?|hxxps?)\s*\/\//i,
  /\bwww\s*[.,]\s*[a-z0-9]/i,
  new RegExp(`\\b[a-z0-9][a-z0-9-]*\\.(?:${TLDS})\\b`, 'i'),                                           // abc.com, bit.ly, t.me
  new RegExp(`\\b[a-z0-9][a-z0-9-]*\\s*(?:\\[\\s*\\.\\s*\\]|\\(\\s*\\.\\s*\\)|\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\)|\\s+dot\\s+)\\s*(?:${TLDS})\\b`, 'i'), // abc dot com, abc[.]com
];
const EMAIL_PATTERNS = [
  /[a-z0-9._%+-]+\s*@\s*[a-z0-9-]+\s*\.\s*[a-z]{2,}/i,
  /[a-z0-9._%+-]+\s*(?:\(at\)|\[at\]|\s+at\s+)\s*(?:gmail|yahoo|outlook|hotmail|rediffmail|icloud|proton(?:mail)?|live|ymail)\b/i,
];
const HANDLE_PATTERN = /(?:^|[^a-z0-9._%+-])@[a-z0-9_.]{2,}/i;
const OFF_PLATFORM_PATTERNS = [
  /\b(?:whats\s*app|whatsapp|watsapp|wa\.me|telegram|tele\s*gram|insta(?:gram)?|snap\s*chat|snapchat|signal|discord|facebook|fb|linkedin|twitter)\s*(?:id|handle|number|no\.?|account|pe|par|par\s*aao|pe\s*aao|me\s*aao|dm|message)\b/i,
  /\b(?:dm|inbox|ping|call|text|message|whatsapp|msg)\s*(?:me|karo|kar\s*do|kr|kro)\b/i,
  /\b(?:my|mera|meri|mere)\s*(?:number|no\.?|num|contact|insta|id|handle|whatsapp|snap|telegram)\b/i,
  /\b(?:add|follow|find)\s*me\s*(?:on|at|pe|par)?\b/i,
  /\b(?:contact|reach|call)\s*(?:me|us)\s*(?:on|at)\b/i,
];

/** The digits a run of numbers / number words spells, ignoring separators. */
function longestDigitRun(text) {
  // Number words → digits (as separate tokens), then strip separators between digits.
  const t = fold(text).replace(/\b[a-z]+\b/g, w => (NUMBER_WORDS[w] !== undefined ? ` ${NUMBER_WORDS[w]} ` : w));
  let best = 0;
  const re = /\d(?:[\s.\-()/_+*]{0,3}\d)*/g;
  let m;
  while ((m = re.exec(t)) !== null) best = Math.max(best, (m[0].match(/\d/g) || []).length);
  return best;
}

function detectContact(text) {
  const f = fold(text);
  if (longestDigitRun(text) >= 10) return 'PHONE';
  if (EMAIL_PATTERNS.some(p => p.test(f))) return 'EMAIL';
  if (URL_PATTERNS.some(p => p.test(f))) return 'LINK';
  if (HANDLE_PATTERN.test(f)) return 'HANDLE';
  if (OFF_PLATFORM_PATTERNS.some(p => p.test(f))) return 'OFF_PLATFORM';
  return null;
}

// ── Profanity (English + romanised Hindi), with disguises ───────────────────
//
// Matched per WORD, never across words ("this hitting" must not read as "shit"). Inside a word,
// leet digits and symbols are mapped, separators removed (f.u.c.k, f-u-c-k), and repeated
// letters squeezed (fuuuck); single letters spaced out ("f u c k") are joined first.

const LEET = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '|': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '6': 'g', '9': 'g' };
const squeeze = w => w.replace(/(.)\1+/g, '$1');
// Whole words (after squeezing); prefixes are matched as stems.
const PROFANE_WORDS = new Set([
  'shit', 'shity', 'bulshit', 'shithole', 'bitch', 'bitches', 'bastard', 'ashole', 'asholes', 'dick', 'dickhead', 'cunt', 'whore', 'slut', 'sluts',
  'pusy', 'cock', 'wanker', 'twat', 'prick', 'jackas', 'retard', 'faggot', 'fag', 'nigger', 'nigga',
  'chutiya', 'chutiye', 'chutia', 'chutiyapa', 'madarchod', 'maderchod', 'behenchod', 'bhenchod', 'benchod', 'bhosdike', 'bhosdi', 'bhosda', 'bhosadike',
  'gandu', 'gaandu', 'lund', 'lauda', 'lavda', 'loda', 'randi', 'randwa', 'harami', 'haramzade', 'haramzada', 'kamina', 'kamine', 'bhadwa', 'bhadwe',
  'jhatu', 'jhaant', 'chodu', 'chut', 'gand', 'bsdk', 'mc', 'bc', 'bkl', 'mkc', 'tmkc', 'bkc', 'lodu', 'tatte', 'gaand',
]);
// Squeezed forms too ("tatte" is typed "tate" after squeezing), except where squeezing would
// collide with an ordinary word.
const SQUEEZE_COLLISIONS = new Set(['niger']);
const PROFANE_SQUEEZED = new Set([...PROFANE_WORDS].map(squeeze).filter(w => !SQUEEZE_COLLISIONS.has(w)));
const PROFANE_STEMS = ['fuck', 'fuk', 'fck', 'motherfuck', 'mothafuck', 'chutiy', 'madarchod', 'behenchod', 'bhenchod', 'bhosd', 'gandu', 'bastard', 'ashole', 'cunt', 'whore', 'slut', 'bitch', 'dickhead'];

function wordsForProfanity(text) {
  let t = fold(text);
  // join single letters spaced/dotted out: "f u c k" / "f.u.c.k" → "fuck"
  t = t.replace(/\b([a-z@$0-9])(?:[\s.\-_*]+[a-z@$0-9]\b){2,}/g, m => m.replace(/[\s.\-_*]+/g, ''));
  return t.split(/\s+/).map(w => {
    const x = w.replace(/./g, c => LEET[c] || c);
    return x.replace(/[^a-z*]/g, '');       // separators inside the word
  }).filter(Boolean);
}
function hasProfanity(text) {
  for (const raw of wordsForProfanity(text)) {
    const w = squeeze(raw);
    if (raw.includes('*')) {                   // f*ck, f**k, b*tch: masked letters
      if (!/[a-z]/.test(raw)) continue;
      const re = new RegExp(`^${raw.replace(/\*+/g, '[a-z]*')}$`);
      if ([...PROFANE_WORDS, ...PROFANE_STEMS].some(p => p.length >= 4 && re.test(p))) return true;
      continue;
    }
    if (PROFANE_WORDS.has(raw) || PROFANE_SQUEEZED.has(w)) return true;
    if (PROFANE_STEMS.some(s => raw.startsWith(s) || w.startsWith(squeeze(s)))) return true;
  }
  return false;
}

// Self-harm wording: refused with care, never treated as abuse.
const SELF_HARM = /\b(kill\s*(?:my)?\s*self|want\s*to\s*die|end\s*(?:my\s*)?life|commit\s*suicide|suicid(?:e|al)|no\s*reason\s*to\s*live|self\s*harm|cut\s*myself)\b/i;

// ── User messages (general; never the word that matched) ────────────────────

const MESSAGES = {
  CONTACT: 'Please keep it on Humrah: no phone numbers, links, emails or social handles.',
  ABUSE:   'Please keep it friendly and respectful: offensive words aren’t allowed.',
  REVIEW:  'Could you rephrase that?',
  SELF_HARM: 'It sounds like you might be going through a lot. You don’t have to face it alone — please reach out to someone you trust, or call Tele-MANAS on 14416 (free, 24×7).',
};

/**
 * The one verdict for a piece of user text (already sanitised or not — it is sanitised here).
 * context: 'question' | 'answer' | 'reply' | other — only used for wording later; rules are the same.
 */
async function moderateUserText(raw, { context = 'text' } = {}) {      // eslint-disable-line no-unused-vars
  const text = sanitizeText(raw);
  if (!text) return { verdict: 'SAFE', reasonCode: null, abusive: false, userMessage: null };

  if (SELF_HARM.test(fold(text))) return { verdict: 'BLOCKED', reasonCode: 'SELF_HARM', abusive: false, userMessage: MESSAGES.SELF_HARM };

  const contact = detectContact(text);
  if (contact) return { verdict: 'BLOCKED', reasonCode: contact === 'LINK' ? 'LINK' : 'CONTACT_INFO', contactKind: contact, abusive: false, userMessage: MESSAGES.CONTACT };

  if (hasProfanity(text)) return { verdict: 'BLOCKED', reasonCode: 'PROFANITY', abusive: true, userMessage: MESSAGES.ABUSE };

  // The existing engine: patterns (solicitation, harassment, hate, zero tolerance) + its AI layer.
  const r = await engine.moderateChatMessage(text);
  if (!r.allowed) {
    if (r.level === engine.LEVEL.SOFT) return { verdict: 'REVIEW', reasonCode: 'NEEDS_REPHRASE', abusive: false, userMessage: MESSAGES.REVIEW };
    if (r.reason === 'policy_solicitation' || r.reason === 'policy_bypass') {
      return { verdict: 'BLOCKED', reasonCode: 'OFF_PLATFORM', abusive: false, userMessage: MESSAGES.CONTACT };
    }
    return { verdict: 'BLOCKED', reasonCode: r.reason === 'ai_flagged' ? 'AI_FLAGGED' : 'ABUSE', abusive: r.level >= engine.LEVEL.POLICY, userMessage: MESSAGES.ABUSE };
  }
  // The engine's chat auto-clean (it strips prices, UPI app names, contact details) is not used:
  // prices and "do they take Paytm?" are ordinary local questions, and contact details were
  // already refused above by detectContact.
  return { verdict: 'SAFE', reasonCode: null, abusive: false, userMessage: null };
}

module.exports = { moderateUserText, sanitizeText, graphemeLength, letterCount, detectContact, hasProfanity, fold, MESSAGES, _internal: { longestDigitRun, wordsForProfanity } };
