// services/engagement/templates.js
// -----------------------------------------------------------------------------
// Notification content. The worker never builds a string itself: it asks for a template
// by key and renders it with validated variables.
//
// Phase 1 ships a fixed, reviewed set of templates (BUILT_IN below). Phase 2 (AI Template
// Studio) plugs in through setTemplateProvider(): any provider that returns templates of
// the same shape is validated by the same render() — so a generated template can never
// reach a phone with a missing or unexpected variable.
//
// Rules render() enforces:
//   - every {placeholder} in the title/body is declared in `vars`, and every declared
//     variable is supplied and passes its validator (enum, or a bounded safe string);
//   - no braces survive rendering; control characters are refused;
//   - title <= 65 and body <= 180 characters after rendering;
//   - the template's category matches the category asked for.
// On any failure it returns { ok: false, reason } — the opportunity is dropped, nothing
// is sent with a broken message.
// -----------------------------------------------------------------------------
'use strict';

const TITLE_MAX = 65;
const BODY_MAX = 180;

const SPORT_LABELS = Object.freeze({
  badminton: 'badminton', football: 'football', cricket: 'cricket', basketball: 'basketball',
  tennis: 'tennis', table_tennis: 'table tennis', running: 'running', cycling: 'cycling',
  gym: 'gym', yoga: 'yoga',
});

// A short public label: letters, digits, spaces and a little punctuation.
const SAFE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} &'’,.\-]{0,39}$/u;

const BUILT_IN = Object.freeze([
  {
    key: 'nearby.new_members', version: 1, category: 'NEARBY',
    title: 'Something new is happening nearby',
    body: 'New people have joined Humrah in your area. Explore your community.',
    vars: {},
  },
  {
    key: 'sports.plan_interest', version: 1, category: 'SPORTS',
    title: 'Find your next sports buddy',
    body: 'A {sportLabel} plan near you has open spots. Explore sports sessions that match your interests.',
    vars: { sportLabel: { type: 'enum', values: Object.values(SPORT_LABELS) } },
  },
  {
    key: 'rooms.active_topic', version: 1, category: 'ROOMS',
    title: 'Conversations are happening',
    body: 'People are chatting in a {roomTopic} Room. Discover active Humrah Rooms and join a discussion.',
    vars: { roomTopic: { type: 'label' } },
  },
  {
    key: 'community.nearby_questions', version: 1, category: 'COMMUNITY',
    title: 'New conversations in your community',
    body: 'People in your area are asking questions on Humrah. Share what you know.',
    vars: {},
  },
  {
    key: 'informative.rooms_intro', version: 1, category: 'INFORMATIVE',
    title: 'Have you tried Humrah Rooms?',
    body: 'Rooms are small group chats about topics you like. Find one that fits you.',
    vars: {},
  },
  {
    key: 'informative.questions_intro', version: 1, category: 'INFORMATIVE',
    title: 'Got a question about your area?',
    body: 'Ask a Question lets you get tips from people near you on Humrah.',
    vars: {},
  },
  {
    key: 'social.make_plan', version: 1, category: 'SOCIAL',
    title: 'Fancy doing something this week?',
    body: 'Make a plan on Humrah and see who would like to join you.',
    vars: {},
  },
  {
    key: 'funny.sofa_break', version: 1, category: 'FUNNY',
    title: 'Your sofa says you deserve a break',
    body: 'We agree. See what is happening on Humrah today.',
    vars: {},
  },
]);

const builtInProvider = {
  name: 'built-in',
  getTemplate: key => BUILT_IN.find(t => t.key === key) || null,
  listTemplates: () => BUILT_IN,
};

let provider = builtInProvider;

/** Phase 2 hook. A provider must expose getTemplate(key) and listTemplates(). */
function setTemplateProvider(p) {
  if (!p || typeof p.getTemplate !== 'function' || typeof p.listTemplates !== 'function') {
    throw new TypeError('A template provider needs getTemplate(key) and listTemplates().');
  }
  provider = p;
}
function resetTemplateProvider() { provider = builtInProvider; }

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]{0,30})\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e]');

function validVar(spec, value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (spec.type === 'enum') return Array.isArray(spec.values) && spec.values.includes(v);
  if (spec.type === 'label') return SAFE_LABEL.test(v) && !CONTROL.test(v);
  return false;
}

/**
 * @returns {{ok:true, title, body, templateKey, templateVersion} | {ok:false, reason}}
 */
function render(templateKey, category, vars = {}) {
  let t;
  try { t = provider.getTemplate(templateKey); } catch (_) { t = null; }
  if (!t) return { ok: false, reason: 'TEMPLATE_MISSING' };
  if (t.category !== category) return { ok: false, reason: 'TEMPLATE_CATEGORY_MISMATCH' };
  if (typeof t.title !== 'string' || typeof t.body !== 'string') return { ok: false, reason: 'TEMPLATE_INVALID' };

  const declared = t.vars && typeof t.vars === 'object' ? t.vars : {};
  const used = new Set();
  for (const s of [t.title, t.body]) for (const m of s.matchAll(PLACEHOLDER)) used.add(m[1]);
  for (const name of used) if (!declared[name]) return { ok: false, reason: 'TEMPLATE_UNDECLARED_VAR' };
  for (const [name, spec] of Object.entries(declared)) {
    if (!validVar(spec, vars[name])) return { ok: false, reason: 'TEMPLATE_VAR_INVALID' };
  }

  const fill = s => s.replace(PLACEHOLDER, (_, name) => String(vars[name]).trim());
  const title = fill(t.title).trim();
  const body = fill(t.body).trim();
  if (!title || !body) return { ok: false, reason: 'TEMPLATE_EMPTY' };
  if (/[{}]/.test(title) || /[{}]/.test(body)) return { ok: false, reason: 'TEMPLATE_UNRESOLVED' };
  if (CONTROL.test(title) || CONTROL.test(body)) return { ok: false, reason: 'TEMPLATE_CONTROL_CHARS' };
  if (title.length > TITLE_MAX || body.length > BODY_MAX) return { ok: false, reason: 'TEMPLATE_TOO_LONG' };
  return { ok: true, title, body, templateKey: t.key, templateVersion: Number(t.version) || 1 };
}

module.exports = {
  render,
  setTemplateProvider,
  resetTemplateProvider,
  SPORT_LABELS,
  BUILT_IN,
  TITLE_MAX,
  BODY_MAX,
};
