// services/engagement/templates.js
// -----------------------------------------------------------------------------
// Notification content: the template pool and the strict renderer.
//
// The worker never builds a string itself. For an opportunity (category + purpose +
// backend-verified variables) it picks a template from the pool and renders it:
//
//   pool = ACTIVE templates from MongoDB (AI-generated or admin-revised, approved by an
//          admin — templateStore.loadActivePool, once per planner run)
//        + the BUILT_IN templates below (the reviewed Phase 1 copy, English) as the
//          safe fallback, unless ENGAGEMENT_BUILTIN_TEMPLATES_ENABLED=false.
//
// Order for one opportunity: stored templates in the user's language, built-ins in that
// language, then the same for English (the fallback language). Within a group, templates
// this user received recently go last, and the rest rotate deterministically by
// hash(user, event, template) — so different people see different copy and nothing is
// random. If no template can be rendered with the variables the backend supplied, the
// opportunity is skipped (NO_APPROVED_TEMPLATE); nothing unapproved is ever sent.
//
// render() enforces, for every template (stored or built-in):
//   every {{placeholder}} is a registry variable allowed for the purpose and present in
//   the backend's validated values; no braces or control characters survive; the
//   rendered title <= 65 and body <= 180 characters; the category/purpose match.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const { SPORT_LABELS, purposeSpec, prepareAll, placeholdersIn, PLACEHOLDER } = require('./variables');
const { CONTROL_RE } = require('./textSafety');

const TITLE_MAX = 65;
const BODY_MAX = 180;
const FALLBACK_LANGUAGE = 'en';

const builtin = (id, category, purpose, tone, title, body) => Object.freeze({
  templateId: `builtin.${id}`, version: 1, category, purpose, language: 'en', tone, title, body, source: 'BUILT_IN', status: 'ACTIVE',
});

// The Phase 1 copy, unchanged in wording; placeholders moved to the {{registry}} names.
const BUILT_IN = Object.freeze([
  builtin('nearby.new_members', 'NEARBY', 'new_members', 'friendly',
    'Something new is happening nearby', 'New people have joined Humrah in your area. Explore your community.'),
  builtin('sports.open_plan', 'SPORTS', 'open_plan', 'friendly',
    'Find your next sports buddy', 'A {{sport_label}} plan near you has open spots. Explore sports sessions that match your interests.'),
  builtin('rooms.active_room', 'ROOMS', 'active_room', 'friendly',
    'Conversations are happening', 'People are chatting in a {{topic_label}} Room. Discover active Humrah Rooms and join a discussion.'),
  builtin('community.nearby_questions', 'COMMUNITY', 'nearby_questions', 'community',
    'New conversations in your community', 'People in your area are asking questions on Humrah. Share what you know.'),
  builtin('informative.rooms_intro', 'INFORMATIVE', 'rooms_intro', 'informative',
    'Have you tried Humrah Rooms?', 'Rooms are small group chats about topics you like. Find one that fits you.'),
  builtin('informative.questions_intro', 'INFORMATIVE', 'questions_intro', 'informative',
    'Got a question about your area?', 'Ask a Question lets you get tips from people near you on Humrah.'),
  builtin('social.make_plan', 'SOCIAL', 'make_plan', 'warm',
    'Fancy doing something this week?', 'Make a plan on Humrah and see who would like to join you.'),
  builtin('funny.light_nudge', 'FUNNY', 'light_nudge', 'funny',
    'Your sofa says you deserve a break', 'We agree. See what is happening on Humrah today.'),
]);

/**
 * Render one template with backend values. `values` must come from variables.prepareAll().
 * @returns {{ok:true, title, body, templateKey, templateVersion, language} | {ok:false, reason}}
 */
function render(t, values) {
  if (!t || typeof t.title !== 'string' || typeof t.body !== 'string') return { ok: false, reason: 'TEMPLATE_INVALID' };
  const spec = purposeSpec(t.category, t.purpose);
  if (!spec) return { ok: false, reason: 'TEMPLATE_PURPOSE_UNKNOWN' };
  const used = placeholdersIn(`${t.title} ${t.body}`);
  for (const n of used) {
    if (!spec.vars.includes(n)) return { ok: false, reason: 'TEMPLATE_VAR_NOT_ALLOWED' };
    if (typeof values[n] !== 'string' || !values[n]) return { ok: false, reason: 'TEMPLATE_VAR_MISSING' };
  }
  const fill = s => s.replace(PLACEHOLDER, (_, n) => values[n]).replace(/\s+/g, ' ').trim();
  const title = fill(t.title);
  const body = fill(t.body);
  if (!title || !body) return { ok: false, reason: 'TEMPLATE_EMPTY' };
  if (/[{}]/.test(title) || /[{}]/.test(body)) return { ok: false, reason: 'TEMPLATE_UNRESOLVED' };
  if (CONTROL_RE.test(title) || CONTROL_RE.test(body)) return { ok: false, reason: 'TEMPLATE_CONTROL_CHARS' };
  if (title.length > TITLE_MAX || body.length > BODY_MAX) return { ok: false, reason: 'TEMPLATE_TOO_LONG' };
  return { ok: true, title, body, templateKey: t.templateId, templateVersion: Number(t.version) || 1, language: t.language || FALLBACK_LANGUAGE, source: t.source || 'AI', templateDocId: t._id || null };
}

const groupKey = (category, purpose, language) => `${category}|${purpose}|${language}`;

/** Build the pool from stored ACTIVE templates (lean docs) and, optionally, the built-ins. */
function buildPool(stored = [], { builtinsEnabled = true } = {}) {
  const stored_ = new Map();
  const builtins = new Map();
  for (const t of stored) {
    const k = groupKey(t.category, t.purpose, t.language);
    if (!stored_.has(k)) stored_.set(k, []);
    stored_.get(k).push({ ...t, source: t.source || 'AI' });
  }
  if (builtinsEnabled) {
    for (const t of BUILT_IN) {
      const k = groupKey(t.category, t.purpose, t.language);
      if (!builtins.has(k)) builtins.set(k, []);
      builtins.get(k).push(t);
    }
  }
  return { stored: stored_, builtins, size: stored.length, builtinsEnabled };
}

const DEFAULT_POOL = buildPool([], { builtinsEnabled: true });

const rank = (userId, eventKey, t) => crypto.createHash('sha1').update(`${userId}|${eventKey}|${t.templateId}|${t.version}`).digest('hex');

function ordered(list, ctx, eventKey) {
  const recent = (ctx && ctx.history && ctx.history.recentTemplateKeys) || new Set();
  const uid = ctx && ctx.userId ? String(ctx.userId) : '';
  return [...list]
    .map(t => ({ t, recent: recent.has(t.templateId) ? 1 : 0, r: rank(uid, eventKey, t) }))
    .sort((a, b) => a.recent - b.recent || (a.r < b.r ? -1 : a.r > b.r ? 1 : 0))
    .map(x => x.t);
}

/**
 * Pick and render a template for one opportunity.
 * @param {object} op   { category, purpose, eventKey, vars }  (vars = raw backend values)
 * @param {object} ctx  { userId, language, history }
 * @param {object} [pool]
 */
function resolve(op, ctx, pool = DEFAULT_POOL) {
  if (!op || !purposeSpec(op.category, op.purpose)) return { ok: false, reason: 'TEMPLATE_PURPOSE_UNKNOWN' };
  const values = prepareAll(op.vars);
  const languages = [...new Set([(ctx && ctx.language) || FALLBACK_LANGUAGE, FALLBACK_LANGUAGE])];
  let lastReason = 'NO_APPROVED_TEMPLATE';
  for (const lang of languages) {
    const k = groupKey(op.category, op.purpose, lang);
    for (const group of [pool.stored.get(k) || [], pool.builtins.get(k) || []]) {
      for (const t of ordered(group, ctx, op.eventKey)) {
        const r = render(t, values);
        if (r.ok) return r;
        lastReason = r.reason;
      }
    }
  }
  return { ok: false, reason: lastReason === 'TEMPLATE_VAR_MISSING' ? 'NO_TEMPLATE_FOR_AVAILABLE_VARIABLES' : lastReason };
}

module.exports = {
  render, resolve, buildPool, DEFAULT_POOL, BUILT_IN, SPORT_LABELS, TITLE_MAX, BODY_MAX, FALLBACK_LANGUAGE, groupKey,
};
