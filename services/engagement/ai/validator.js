// services/engagement/ai/validator.js
// -----------------------------------------------------------------------------
// Template validation — used for every AI-generated candidate before it is stored, for
// every admin revision, and again at approval time. Pure functions.
//
//   parseCandidates(text)          JSON structure (tolerates a ```json fence; nothing else)
//   validateRequest(input, cfg)    a generation request from an admin or the scheduler
//   validateTemplate(item, ctx)    one template → { ok, value } or { ok:false, code }
//   similarity(a, b)               word-set Jaccard on normalised text
//
// Template checks (each failure is a reason code):
//   structure, empty, length (raw AND worst-case rendered), placeholders (syntax,
//   registry, allowed for the purpose), markup/links, digits outside placeholders,
//   language/script, prohibited content (contentRules), activity claims in categories
//   with no live event, punctuation/caps/emoji excess, INFORMATIVE must name its
//   feature, tone echo, exact and near duplicates (within the batch and against stored).
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const { CATEGORIES } = require('../../../config/engagementNotificationConfig');
const { LANGUAGES, TONES } = require('../../../config/engagementAiConfig');
const { VARIABLES, purposeSpec, placeholdersIn } = require('../variables');
const { CONTROL_RE } = require('../textSafety');
const { activeEntries } = require('../catalog');
const R = require('./contentRules');

const VALIDATION_VERSION = 1;
const HARD_TITLE_MAX = 65;    // Phase 1 render limits
const HARD_BODY_MAX = 180;
const EVENT_BACKED = new Set(['NEARBY', 'COMMUNITY', 'SPORTS', 'ROOMS']);

const normalise = s => String(s || '').toLowerCase().replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, ' $1 ')
  .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const contentHash = (title, body) => crypto.createHash('sha256').update(`${normalise(title)}|${normalise(body)}`).digest('hex');

function similarity(a, b) {
  const A = new Set(normalise(a).split(' ').filter(Boolean));
  const B = new Set(normalise(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── Generation request ───────────────────────────────────────────────────────
const REQUEST_KEYS = new Set(['category', 'purpose', 'language', 'tone', 'count', 'variables', 'force']);

/** @returns {{ok:true, value}|{ok:false, code, field}} */
function validateRequest(input, cfg) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID_REQUEST', field: null };
  for (const k of Object.keys(input)) if (!REQUEST_KEYS.has(k)) return { ok: false, code: 'UNKNOWN_FIELD', field: k };
  const category = typeof input.category === 'string' ? input.category.trim().toUpperCase() : '';
  if (!CATEGORIES.includes(category)) return { ok: false, code: 'UNSUPPORTED_CATEGORY', field: 'category' };
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
  if (category === 'SEASONAL') {
    // Only an approved, dated seasonal catalog entry may be written for. None ship in Phase 2.
    const live = activeEntries(Date.now()).some(e => e.category === 'SEASONAL' && e.purpose === purpose);
    if (!live) return { ok: false, code: 'SEASONAL_REQUIRES_APPROVED_EVENT', field: 'purpose' };
  }
  const spec = purposeSpec(category, purpose);
  if (!spec) return { ok: false, code: 'UNSUPPORTED_PURPOSE', field: 'purpose' };
  const language = typeof input.language === 'string' ? input.language.trim().toLowerCase() : cfg.defaultLanguage;
  if (!LANGUAGES.includes(language)) return { ok: false, code: 'UNSUPPORTED_LANGUAGE', field: 'language' };
  const tone = typeof input.tone === 'string' ? input.tone.trim().toLowerCase() : '';
  if (!TONES.includes(tone)) return { ok: false, code: 'UNSUPPORTED_TONE', field: 'tone' };
  const count = input.count === undefined ? Math.min(5, cfg.maxBatchSize) : input.count;
  if (!Number.isInteger(count) || count < 1 || count > cfg.maxBatchSize) return { ok: false, code: 'INVALID_COUNT', field: 'count' };
  let variables = spec.vars.slice();
  if (input.variables !== undefined) {
    if (!Array.isArray(input.variables) || input.variables.some(v => typeof v !== 'string' || !spec.vars.includes(v))) return { ok: false, code: 'VARIABLE_NOT_ALLOWED', field: 'variables' };
    variables = [...new Set(input.variables)];
  }
  if (input.force !== undefined && typeof input.force !== 'boolean') return { ok: false, code: 'INVALID_FORCE', field: 'force' };
  return { ok: true, value: { category, purpose, language, tone, count, titleMax: cfg.titleMax, bodyMax: cfg.bodyMax, variables, force: input.force === true } };
}

// ── Candidates ───────────────────────────────────────────────────────────────
/** @returns {{ok:true, items:object[]}|{ok:false, code}} */
function parseCandidates(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'EMPTY_RESPONSE' };
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1];
  let data;
  try { data = JSON.parse(s); } catch (_) { return { ok: false, code: 'INVALID_JSON' }; }
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.templates) ? data.templates : null);
  if (!items) return { ok: false, code: 'MISSING_TEMPLATES_ARRAY' };
  if (items.length === 0) return { ok: false, code: 'EMPTY_TEMPLATES' };
  return { ok: true, items: items.slice(0, 50) };
}

function scriptOk(text, language) {
  const plain = text.replace(/\{\{\s*[a-z0-9_]+\s*\}\}/g, ' ');
  const dev = (plain.match(R.DEVANAGARI) || []).length;
  const lat = (plain.match(R.LATIN) || []).length;
  if (language === 'hi') return dev > 0 && dev >= 3 * lat;   // Devanagari, with at most a stray Latin word
  return dev === 0 && lat > 0;                                 // en and hinglish: Latin script only
}

function rendersWithin(text, max) {
  const worst = text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_, n) => (VARIABLES[n] ? VARIABLES[n].worstCase : ''));
  return worst.length <= max;
}

/**
 * @param {object} item  { title, body, tone? }
 * @param {object} ctx   { category, purpose, language, tone, titleMax, bodyMax, requireTone }
 */
function validateTemplate(item, ctx) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'INVALID_STRUCTURE' };
  if (typeof item.title !== 'string' || typeof item.body !== 'string') return { ok: false, code: 'MISSING_FIELDS' };
  const title = item.title.replace(/\s+/g, ' ').trim();
  const body = item.body.replace(/\s+/g, ' ').trim();
  if (!title || !body) return { ok: false, code: 'EMPTY_CONTENT' };
  if (ctx.requireTone && item.tone !== undefined && String(item.tone).trim().toLowerCase() !== ctx.tone) return { ok: false, code: 'TONE_MISMATCH' };
  const spec = purposeSpec(ctx.category, ctx.purpose);
  if (!spec) return { ok: false, code: 'UNSUPPORTED_PURPOSE' };
  if (title.length > ctx.titleMax) return { ok: false, code: 'TITLE_TOO_LONG' };
  if (body.length > ctx.bodyMax) return { ok: false, code: 'BODY_TOO_LONG' };
  const both = `${title} ${body}`;
  if (CONTROL_RE.test(both)) return { ok: false, code: 'CONTROL_CHARACTERS' };

  // Placeholders: exact {{name}} syntax, known, allowed for this purpose; no other braces.
  const stripped = both.replace(/\{\{\s*[a-z][a-z0-9_]{0,40}\s*\}\}/g, '');
  if (/[{}]|\$\{|%s|%d/.test(stripped)) return { ok: false, code: 'MALFORMED_PLACEHOLDER' };
  const used = placeholdersIn(both);
  for (const n of used) {
    if (!VARIABLES[n]) return { ok: false, code: 'UNKNOWN_PLACEHOLDER' };
    if (!spec.vars.includes(n)) return { ok: false, code: 'PLACEHOLDER_NOT_ALLOWED' };
  }
  if (!rendersWithin(title, HARD_TITLE_MAX) || !rendersWithin(body, HARD_BODY_MAX)) return { ok: false, code: 'RENDERED_TOO_LONG' };

  if (R.MARKUP.test(both)) return { ok: false, code: 'MARKUP_OR_LINK' };
  if (R.DIGIT.test(stripped)) return { ok: false, code: 'UNSUPPORTED_NUMBER' };
  if (!scriptOk(title, ctx.language) || !scriptOk(body, ctx.language)) return { ok: false, code: 'LANGUAGE_MISMATCH' };

  const plain = normalise(both);
  const raw = both.toLowerCase();
  for (const rule of R.RULES) if (rule.re.test(raw) || rule.re.test(plain)) return { ok: false, code: rule.code };
  if (!EVENT_BACKED.has(ctx.category) && R.ACTIVITY_CLAIM.test(raw)) return { ok: false, code: 'UNSUPPORTED_ACTIVITY_CLAIM' };
  if (spec.mustMention && !spec.mustMention.test(both)) return { ok: false, code: 'FEATURE_NOT_MENTIONED' };

  const bangs = (both.match(/!/g) || []).length;
  if (bangs > 1 || /[!?]{2,}|\.{4,}|(\.\.\.).*\.\.\./.test(both)) return { ok: false, code: 'EXCESSIVE_PUNCTUATION' };
  if (/\b[A-Z]{4,}\b/.test(both.replace(/\{\{[^}]*\}\}/g, ''))) return { ok: false, code: 'SHOUTING' };
  if ((both.match(R.EMOJI) || []).length > 1) return { ok: false, code: 'TOO_MANY_EMOJI' };
  const tokens = plain.split(' ').filter(Boolean);
  if (tokens.length >= 4 && new Set(tokens).size / tokens.length < 0.5) return { ok: false, code: 'REPETITIVE' };

  return { ok: true, value: { title, body, variables: used, contentHash: contentHash(title, body) } };
}

/**
 * Validate a whole parsed batch against itself and the stored templates.
 * @param {object[]} items
 * @param {object} ctx  as validateTemplate, plus { existing: [{title, body, contentHash}], similarityThreshold }
 * @returns {{accepted: object[], rejected: {code:string}[]}}
 */
function validateBatch(items, ctx) {
  const accepted = [];
  const rejected = [];
  const known = (ctx.existing || []).map(e => ({ text: `${e.title} ${e.body}`, hash: e.contentHash }));
  for (const item of items) {
    const r = validateTemplate(item, { ...ctx, requireTone: true });
    if (!r.ok) { rejected.push({ code: r.code }); continue; }
    const text = `${r.value.title} ${r.value.body}`;
    if (known.some(k => k.hash === r.value.contentHash)) { rejected.push({ code: 'DUPLICATE' }); continue; }
    if (known.some(k => similarity(k.text, text) >= ctx.similarityThreshold)) { rejected.push({ code: 'NEAR_DUPLICATE' }); continue; }
    known.push({ text, hash: r.value.contentHash });
    accepted.push(r.value);
  }
  return { accepted, rejected };
}

module.exports = {
  VALIDATION_VERSION, HARD_TITLE_MAX, HARD_BODY_MAX,
  validateRequest, parseCandidates, validateTemplate, validateBatch, similarity, contentHash, normalise,
};
