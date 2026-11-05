// utils/roomCreateValidation.js
// -----------------------------------------------------------------------------
// Rooms Phase 2.3 — input limits for POST /api/rooms (description, languages).
//
// SUPPORTED LANGUAGES: the backend has no language list of its own
// (User.questionnaire.preferredLanguages is a free [String]). The single source of
// truth is the Android app's LanguageData.allSupportedLanguages — the list the
// questionnaire offers, from which a user's preferredLanguages (and therefore the
// Create Room language chips) come. This mirrors its English names exactly. Keep the
// two in sync.
//
// Both fields stay OPTIONAL: an app that sends no description or no languages is
// unaffected. Values are matched ignoring case and stored with the canonical spelling.
// -----------------------------------------------------------------------------
'use strict';

const MAX_DESCRIPTION_CHARS = 200;
const MAX_LANGUAGES = 5;

// app/src/main/java/in/humrah/app/LanguageData.kt — allSupportedLanguages[].name
const SUPPORTED_LANGUAGES = Object.freeze([
  'Hindi', 'English', 'Bengali', 'Telugu', 'Marathi', 'Tamil', 'Gujarati', 'Urdu',
  'Kannada', 'Odia', 'Malayalam', 'Punjabi', 'Assamese', 'Maithili', 'Santali',
  'Kashmiri', 'Nepali', 'Konkani', 'Sindhi', 'Dogri', 'Manipuri', 'Bodo',
]);
const CANONICAL = new Map(SUPPORTED_LANGUAGES.map(l => [l.toLowerCase(), l]));

/**
 * @returns {{ description: string, languages: string[] } | { error: string }}
 */
function validateRoomCreateInput({ description, languages } = {}) {
  let desc = '';
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') return { error: 'Invalid description' };
    desc = description.trim();
    if (desc.length > MAX_DESCRIPTION_CHARS) {
      return { error: `Description must be at most ${MAX_DESCRIPTION_CHARS} characters` };
    }
  }

  const langs = [];
  if (languages !== undefined && languages !== null) {
    if (!Array.isArray(languages)) return { error: 'Invalid languages' };
    for (const l of languages) {
      const canonical = typeof l === 'string' ? CANONICAL.get(l.trim().toLowerCase()) : undefined;
      if (!canonical) return { error: 'Unsupported language' };
      if (!langs.includes(canonical)) langs.push(canonical);
    }
    if (langs.length > MAX_LANGUAGES) return { error: `Choose at most ${MAX_LANGUAGES} languages` };
  }
  return { description: desc, languages: langs };
}

module.exports = { MAX_DESCRIPTION_CHARS, MAX_LANGUAGES, SUPPORTED_LANGUAGES, validateRoomCreateInput };
