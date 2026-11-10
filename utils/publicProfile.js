// utils/publicProfile.js — what other users may see of a person (Phase 4.3).
//
// ONE allow-list, shared by every endpoint that returns another user's profile data. It is the
// list User.getPublicProfile() already published (the product's own definition of a public
// profile), plus `languagePreference` — the legacy twin of `preferredLanguages`, which the Android
// app still reads for older profiles.
//
// Never public: dateOfBirth, age, income, relationship/smoking/drinking status, profession,
// education, lookingFor, personalityType, pet/fitness, connectAndEarn, consent records,
// progressive-question bookkeeping — or anything outside the questionnaire such as email, phone,
// tokens, exact coordinates, verification media, trusted contacts or moderation/payment data.
'use strict';

const PUBLIC_QUESTIONNAIRE_FIELDS = Object.freeze([
  'city', 'state', 'area', 'preferredLanguages', 'languagePreference', 'gender', 'interests', 'ageGroup',
  'bio', 'goodMeetupMeaning', 'vibeQuote', 'lookingForOnHumrah', 'vibeWords', 'conversationInterests',
  'humrahRoomInterests', 'hangoutPreferences', 'availableTimes', 'socialVibe', 'movieGenre', 'favoriteFood',
  'travelPreference', 'musicPreference', 'comfortActivity', 'relaxActivity', 'comfortZones', 'budgetComfort',
  'hangoutFrequency', 'hobbies',
]);

/** Host (Companion) fields — public on a Companion's profile only (as in getPublicProfile). */
const PUBLIC_HOST_FIELDS = Object.freeze(['becomeCompanion', 'openFor', 'availability', 'price', 'costSharingPreference', 'tagline']);

/**
 * Mongoose projection for the public questionnaire, e.g.
 *   .select(`firstName profilePhoto ${publicQuestionnaireSelect()}`)
 *   .populate('initiatorId', `firstName profilePhoto ${publicQuestionnaireSelect()}`)
 * The response keeps its shape (`questionnaire: {...}`) with only allowed keys present.
 */
function publicQuestionnaireSelect({ includeHostFields = true } = {}) {
  const fields = includeHostFields ? [...PUBLIC_QUESTIONNAIRE_FIELDS, ...PUBLIC_HOST_FIELDS] : PUBLIC_QUESTIONNAIRE_FIELDS;
  return fields.map((f) => `questionnaire.${f}`).join(' ');
}

/** Plain-object filter for code that already holds a full questionnaire. */
function toPublicQuestionnaire(q, { isCompanion = false } = {}) {
  if (!q || typeof q !== 'object') return q;
  const src = typeof q.toObject === 'function' ? q.toObject() : q;
  const out = {};
  for (const f of PUBLIC_QUESTIONNAIRE_FIELDS) if (src[f] !== undefined) out[f] = src[f];
  if (isCompanion) for (const f of PUBLIC_HOST_FIELDS) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

/**
 * A Surprise Activity as another user may see it: the exact spot it was created from (the
 * creator's GPS fix) is removed; distance and the city/state label stay. Owners keep theirs.
 */
function withoutExactLocation(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  const b = { ...booking };
  delete b.lat; delete b.lng;
  if (b.matchSearchLocation && typeof b.matchSearchLocation === 'object') {
    const { city = null, state = null } = b.matchSearchLocation;
    b.matchSearchLocation = { city, state };
  }
  return b;
}

module.exports = { PUBLIC_QUESTIONNAIRE_FIELDS, PUBLIC_HOST_FIELDS, publicQuestionnaireSelect, toPublicQuestionnaire, withoutExactLocation };
