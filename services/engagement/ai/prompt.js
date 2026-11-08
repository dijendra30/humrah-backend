// services/engagement/ai/prompt.js
// -----------------------------------------------------------------------------
// Builds the generation prompt. Its ONLY inputs are the validated generation request
// (category, purpose, language, tone, count, limits, allowed variable NAMES) and a list
// of existing generic template texts to avoid repeating. It has no parameter through
// which a user, a location, an id or any record could reach a provider.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const { VARIABLES, purposeSpec } = require('../variables');

const PROMPT_VERSION = 1;

const LANGUAGE_RULES = Object.freeze({
  en: 'Write in simple, natural English (Latin script).',
  hi: 'Write in natural, simple Hindi using Devanagari script only. Do not mix in English words or Latin script, except the {{placeholders}}.',
  hinglish: 'Write in Hinglish: conversational Hindi written in the Latin (Roman) script, the way young people in India text. Do not use Devanagari. Keep it natural, not mixed randomly with formal English.',
});

const PLATFORM_CONTEXT = [
  'Humrah is an Indian companionship and community app for making friends and doing things together.',
  'It is NOT a dating app. Never suggest romance, dating, flirting, attraction or "matches".',
  'Features that exist: Humrah Rooms (small public group chats about topics), Sports plans (public games people can join),',
  'Ask a Question (ask people nearby for local tips), new members joining in an area, making a plan.',
].join(' ');

const RULES = [
  'Each template has a "title" and a "body". They are shown in a phone notification.',
  'Use ONLY the placeholders listed as allowed, written exactly as {{name}}. Never invent other placeholders, names, numbers, places, dates or facts.',
  'Never write a digit; if a number is needed, use an allowed count placeholder.',
  'Never mention or describe a specific person, and never say someone is waiting for, looking for, messaging or liking the reader.',
  'No pressure or guilt: no "last chance", "hurry", "don\'t miss out", "before it\'s too late", no loneliness or feelings about the reader.',
  'No exaggeration or false claims: say only what the purpose states. No "best", "guaranteed", "everyone", "#1".',
  'Humour must be kind, inclusive and about everyday life — never about any group, body, religion, caste, gender or region.',
  'No links, emails, phone numbers, hashtags, HTML, markdown or code. At most one exclamation mark per template, at most one emoji.',
  'Every template must be clearly different from the others and from the "avoid" list.',
];

/**
 * @param {object} req  validated request { category, purpose, language, tone, count, titleMax, bodyMax, variables }
 * @param {string[]} avoid  existing template texts in this category/language (generic copy, no user data)
 */
function buildPrompt(req, avoid = []) {
  const spec = purposeSpec(req.category, req.purpose);
  const vars = (req.variables || []).map(n => `{{${n}}} = ${VARIABLES[n].description} (example value: "${VARIABLES[n].sample}")`);
  const system = [
    'You write short, warm push-notification templates for an app. You only ever output JSON.',
    PLATFORM_CONTEXT,
    'Rules:',
    ...RULES.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n');
  const user = JSON.stringify({
    task: `Write ${req.count} different notification templates.`,
    category: req.category,
    purpose: spec ? spec.describe : req.purpose,
    tone: req.tone,
    language: LANGUAGE_RULES[req.language],
    allowedPlaceholders: vars.length ? vars : 'none — do not use any placeholder',
    placeholdersAreOptional: true,
    maxTitleCharacters: req.titleMax,
    maxBodyCharacters: req.bodyMax,
    avoidRepeating: avoid.slice(0, 20),
    outputFormat: { templates: [{ title: 'string', body: 'string', tone: req.tone }] },
  });
  return { system, user, version: PROMPT_VERSION };
}

/** Stable hash of what a request would ask (identical requests are not re-sent within the window). */
function promptHash(req) {
  const stable = JSON.stringify([PROMPT_VERSION, req.category, req.purpose, req.language, req.tone, req.count, req.titleMax, req.bodyMax, [...(req.variables || [])].sort()]);
  return crypto.createHash('sha256').update(stable).digest('hex');
}

module.exports = { buildPrompt, promptHash, PROMPT_VERSION, LANGUAGE_RULES };
