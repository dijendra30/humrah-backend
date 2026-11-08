// services/engagement/catalog.js
// -----------------------------------------------------------------------------
// Approved catalog content for the categories that have no live event behind them:
// INFORMATIVE, SOCIAL, FUNNY, SEASONAL. These categories are OFF by default
// (ENGAGEMENT_CATEGORIES_ENABLED) and must be switched on by an operator.
//
// Each entry may require a fact about the user's OWN account (never anyone else's):
//   NEVER_JOINED_ROOM     the user has no Room membership at all
//   NEVER_ASKED_QUESTION  the user has never asked a question
//
// SEASONAL entries need activeFrom/activeUntil (ISO dates, from < until, at most 31
// days apart). Phase 1 ships NO seasonal entry: festival content needs approved dates
// and copy, which belongs to the Phase 3 admin flow. validateCatalog() rejects bad rows.
// -----------------------------------------------------------------------------
'use strict';

const MAX_SEASON_MS = 31 * 24 * 3600 * 1000;

const CATALOG = Object.freeze([
  // `purpose` is the template purpose (variables.PURPOSES) the copy is chosen for.
  { key: 'rooms_intro', category: 'INFORMATIVE', purpose: 'rooms_intro', requires: 'NEVER_JOINED_ROOM' },
  { key: 'questions_intro', category: 'INFORMATIVE', purpose: 'questions_intro', requires: 'NEVER_ASKED_QUESTION' },
  { key: 'make_plan', category: 'SOCIAL', purpose: 'make_plan', requires: null },
  { key: 'light_nudge', category: 'FUNNY', purpose: 'light_nudge', requires: null },
  // SEASONAL: intentionally empty. A seasonal entry needs approved dates AND a purpose,
  // and only then can templates be generated for it (validator.validateRequest).
]);

const REQUIREMENTS = Object.freeze(['NEVER_JOINED_ROOM', 'NEVER_ASKED_QUESTION']);

/** Returns the entries that are well-formed; logs nothing (the caller counts drops). */
function validateCatalog(entries = CATALOG) {
  const valid = [];
  const invalid = [];
  for (const e of entries) {
    const okBase = e && typeof e.key === 'string' && /^[a-z0-9_]{1,40}$/.test(e.key)
      && typeof e.purpose === 'string' && /^[a-z0-9_]{1,40}$/.test(e.purpose)
      && ['INFORMATIVE', 'SOCIAL', 'FUNNY', 'SEASONAL'].includes(e.category)
      && (e.requires === null || e.requires === undefined || REQUIREMENTS.includes(e.requires));
    let okDates = true;
    if (e && (e.category === 'SEASONAL' || e.activeFrom || e.activeUntil)) {
      const from = Date.parse(e.activeFrom);
      const until = Date.parse(e.activeUntil);
      okDates = Number.isFinite(from) && Number.isFinite(until) && from < until && (until - from) <= MAX_SEASON_MS;
    }
    (okBase && okDates ? valid : invalid).push(e);
  }
  return { valid, invalid };
}

/** Entries live at `now` (date window respected). */
function activeEntries(now, entries = CATALOG) {
  return validateCatalog(entries).valid.filter(e => {
    if (!e.activeFrom && !e.activeUntil) return true;
    return Date.parse(e.activeFrom) <= now && now < Date.parse(e.activeUntil);
  });
}

module.exports = { CATALOG, REQUIREMENTS, validateCatalog, activeEntries };
