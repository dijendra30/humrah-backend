// services/engagement/variables.js
// -----------------------------------------------------------------------------
// The STRICT variable and purpose registry (Phase 2).
//
// A template may only contain {{placeholders}} named here, and only those its PURPOSE
// allows. Every value comes from the backend (the Phase 1 opportunity sources and the
// recipient's own context) — never from an AI provider — and is validated and
// formatted here before it reaches a template:
//
//   area_label         the recipient's OWN coarse city label (liveLocation.city), only
//                      while "Nearby activities" is on. Never another person's place.
//   new_member_count   newcomers counted by the NEARBY source (always >= 3; "10+" above 9)
//   sport_label        a known sport (sportsPlanService SPORT_TYPES)
//   open_plan_count    usable open plans found nearby (only when >= 2; "10+" above 9)
//   topic_label        a canonical Room topic (utils/roomTopicConfig)
//   public_room_count  matching public Rooms (only when >= 2; "10+" above 9)
//   question_count     visible nearby questions (only when >= 2; "10+" above 9)
//
// Counts below 2 are never supplied, so a template never says "1 plans". A template
// whose placeholders are not all available for a given opportunity is simply not
// eligible for it; another template (or the built-in fallback) is used.
// -----------------------------------------------------------------------------
'use strict';

const { GLOBAL_TOPICS, LOCATION_TOPICS } = require('../../utils/roomTopicConfig');

const SPORT_LABELS = Object.freeze({
  badminton: 'badminton', football: 'football', cricket: 'cricket', basketball: 'basketball',
  tennis: 'tennis', table_tennis: 'table tennis', running: 'running', cycling: 'cycling',
  gym: 'gym', yoga: 'yoga',
});

const TOPICS = Object.freeze([...new Set([...GLOBAL_TOPICS, ...Object.values(LOCATION_TOPICS).flat()])]);

// A short public label: letters (any script), digits, spaces and a little punctuation.
const SAFE_LABEL = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} &'’,.\-]{0,39}$/u;
const { UNSAFE_VALUE_RE: UNSAFE_CHARS } = require('./textSafety');

const VARIABLES = Object.freeze({
  area_label:        { type: 'label', sample: 'Pune', worstCase: 'x'.repeat(24), description: "the recipient's own city (coarse)" },
  new_member_count:  { type: 'count', min: 3, sample: '5', worstCase: '10+', description: 'how many new members joined nearby' },
  sport_label:       { type: 'enum', values: Object.values(SPORT_LABELS), sample: 'badminton', worstCase: 'table tennis', description: 'a sport name' },
  open_plan_count:   { type: 'count', min: 2, sample: '3', worstCase: '10+', description: 'how many open sports plans are nearby' },
  topic_label:       { type: 'enum', values: TOPICS, sample: 'Music', worstCase: 'x'.repeat(31), description: 'a Room topic' },
  public_room_count: { type: 'count', min: 2, sample: '3', worstCase: '10+', description: 'how many matching public Rooms are active' },
  question_count:    { type: 'count', min: 2, sample: '4', worstCase: '10+', description: 'how many new nearby questions are open' },
});

// category → purpose → { vars allowed, what it is for (prompt context), feature it must mention }
const PURPOSES = Object.freeze({
  NEARBY: {
    new_members: { vars: ['area_label', 'new_member_count'], describe: 'Tell the user that new people have joined Humrah in their general area.' },
  },
  SPORTS: {
    open_plan: { vars: ['sport_label', 'open_plan_count', 'area_label'], describe: 'Tell the user that a public sports plan near them has open spots.' },
  },
  ROOMS: {
    active_room: { vars: ['topic_label', 'public_room_count'], describe: 'Tell the user that a public Humrah Room on a topic they follow has an active conversation.' },
  },
  COMMUNITY: {
    nearby_questions: { vars: ['question_count', 'area_label'], describe: 'Tell the user that people in their area are asking public questions they could help answer.' },
  },
  INFORMATIVE: {
    rooms_intro: { vars: [], describe: 'Introduce Humrah Rooms: small group chats about topics people like.', mustMention: /room|रूम/i },
    questions_intro: { vars: [], describe: 'Introduce Ask a Question: asking people nearby for local tips.', mustMention: /question|sawal|savaal|सवाल|प्रश्न/i },
  },
  SOCIAL: {
    make_plan: { vars: [], describe: 'Invite the user to make a plan on Humrah and see who would like to join.' },
  },
  FUNNY: {
    light_nudge: { vars: [], describe: 'A friendly, light-hearted nudge to open Humrah. No claims about activity.' },
  },
  // SEASONAL purposes exist only for approved, dated catalog entries (catalog.js); none ship.
  SEASONAL: {},
});

const isPurpose = (category, purpose) => !!(PURPOSES[category] && Object.prototype.hasOwnProperty.call(PURPOSES[category], purpose));
const purposeSpec = (category, purpose) => (isPurpose(category, purpose) ? PURPOSES[category][purpose] : null);

function formatCount(n, min) {
  if (!Number.isInteger(n) || n < min) return null;
  return n >= 10 ? '10+' : String(n);
}

/** One backend value → its final, safe string, or null when it must not be used. */
function prepareValue(name, raw) {
  const spec = VARIABLES[name];
  if (!spec || raw === undefined || raw === null) return null;
  let v;
  if (spec.type === 'count') v = formatCount(typeof raw === 'number' ? raw : Number.NaN, spec.min);
  else if (spec.type === 'enum') v = typeof raw === 'string' && spec.values.includes(raw.trim()) ? raw.trim() : null;
  else if (spec.type === 'label') v = typeof raw === 'string' && SAFE_LABEL.test(raw.trim()) ? raw.trim() : null;
  if (v === null || v === undefined) return null;
  if (UNSAFE_CHARS.test(v)) return null;   // defence in depth: nothing markup-like ever renders
  return v;
}

/** Backend vars → validated string map (invalid/unknown entries are dropped, never passed on). */
function prepareAll(vars) {
  const out = {};
  for (const [k, raw] of Object.entries(vars || {})) {
    const v = prepareValue(k, raw);
    if (v !== null) out[k] = v;
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,40})\s*\}\}/g;
/** Placeholder names used in a text (in order, unique). */
function placeholdersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PLACEHOLDER)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

module.exports = {
  VARIABLES, PURPOSES, SPORT_LABELS, TOPICS, SAFE_LABEL, PLACEHOLDER,
  isPurpose, purposeSpec, prepareValue, prepareAll, placeholdersIn, formatCount,
};
