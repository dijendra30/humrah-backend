/**
 * calculateProfileCompletion(user)
 *
 * SINGLE SOURCE OF TRUTH for profile completion across the entire Humrah platform
 * (Android app, Admin Dashboard, analytics). Computed in the User pre-save hook and
 * surfaced as user.profileCompletion — Android only ever displays that number, it
 * never recalculates. There is deliberately no second formula anywhere.
 *
 * MODEL — flat, item-based:
 *
 *              completed applicable items
 *              --------------------------  x 100
 *                total applicable items
 *
 * Every applicable item carries EQUAL weight. This replaces the previous
 * category-weighted model (registration 40 / profile 30 / photos 10 /
 * verification 10 / host 10), under which answering one question inside a small
 * category moved the number far more than answering one inside a large category,
 * and a mostly-empty profile could read ~22%.
 *
 * ITEM SET — derived from the ACTUAL question definitions, not from schema fields:
 *   - onboarding : the 19 questions in QuestionnaireData.kt `onboardingScreens`
 *                  (including the optional later-screen questions — they are still
 *                  onboarding questions)
 *   - profile    : the questions in ProfileQuestionsData.kt (201-203, plus 501 and
 *                  the conditional 502-505)
 *   - profilePhoto      : 1 item
 *   - identityVerified  : 1 item
 *
 * Fields with no corresponding question are NOT items. The previous version counted
 * `name`, `hangoutPreferences`, `lookingForOnHumrah`, `publicPlacesOnly`,
 * `meetupPreference` and `ageGroup` — none of which are questions in the current
 * onboarding set (`meetupPreference` is a Home progressive prompt, and `ageGroup`
 * is derived from the dateOfBirth answer, so counting it double-counted one answer).
 *
 * NO DOUBLE COUNTING: each item is keyed by QUESTION, so a user attribute with more
 * than one backend representation (hobbies/interests, dateOfBirth/age/ageGroup,
 * preferredLanguages/languagePreference) is credited exactly once.
 */
'use strict';

const isBlank = (v) => !v || String(v).trim().length === 0;
const isEmpty = (v) => !v || !Array.isArray(v) || v.length === 0;

/** Mirrors QuestionnaireData.kt `onboardingScreens`. Kotlin is the source of truth. */
const ONBOARDING_QUESTIONS = [
  { id: 10, key: 'dateOfBirth',          type: 'string' },
  { id: 2,  key: 'city',                 type: 'string' },
  { id: 3,  key: 'preferredLanguages',   type: 'array'  },
  { id: 25, key: 'gender',               type: 'string' },
  { id: 5,  key: 'availableTimes',       type: 'array'  },
  { id: 8,  key: 'vibeWords',            type: 'array'  },
  { id: 11, key: 'conversationInterests', type: 'array' },
  { id: 24, key: 'humrahRoomInterests',  type: 'array'  }, // explicit-answer only
  { id: 12, key: 'movieGenre',           type: 'string' },
  { id: 13, key: 'favoriteFood',         type: 'string' },
  { id: 14, key: 'hobbies',              type: 'array'  },
  { id: 15, key: 'travelPreference',     type: 'string' },
  { id: 17, key: 'socialVibe',           type: 'string' },
  { id: 18, key: 'comfortZones',         type: 'array'  },
  { id: 19, key: 'budgetComfort',        type: 'string' },
  { id: 20, key: 'hangoutFrequency',     type: 'string' },
  { id: 21, key: 'comfortActivity',      type: 'array'  },
  { id: 22, key: 'relaxActivity',        type: 'array'  },
  { id: 23, key: 'musicPreference',      type: 'array'  },
];

/** Mirrors ProfileQuestionsData.kt "About You". Always applicable. */
const PROFILE_QUESTIONS = [
  { id: 201, key: 'bio',               type: 'string' },
  { id: 202, key: 'goodMeetupMeaning', type: 'string' },
  { id: 203, key: 'vibeQuote',         type: 'string' },
];

/** ProfileQuestionsData.kt "Activity Host Mode" — the gate question. Always applicable. */
const HOST_INTEREST_QUESTION = { id: 501, key: 'becomeCompanion', type: 'host_interest' };

/** Applicable ONLY when the user answered 501 with HOST_INTERESTED_ANSWER. */
const HOST_CONDITIONAL_QUESTIONS = [
  { id: 502, key: 'openFor',               type: 'array'  },
  { id: 503, key: 'availability',          type: 'string' },
  { id: 504, key: 'costSharingPreference', type: 'string' },
  { id: 505, key: 'tagline',               type: 'string' },
];

/**
 * Only an affirmative answer completes the host-interest item. "Maybe later" and
 * "No, just looking for friends" are answers to the question, but they are not
 * completion of the host item — and they keep 502-505 out of the denominator.
 */
const HOST_INTERESTED_ANSWER = "Yes, I'm interested";

/** Q24 is complete only via the explicit progressive marker, never field emptiness. */
const EXPLICIT_ANSWER_QUESTION_IDS = new Set([24]);

/** Is one question answered? */
function isQuestionAnswered(question, q, answeredIds) {
  if (EXPLICIT_ANSWER_QUESTION_IDS.has(question.id)) {
    // Room creation appends the chosen topic to humrahRoomInterests, which must
    // never read as "the user answered Q24". Only the explicit marker counts.
    return answeredIds.has(question.id);
  }
  if (question.type === 'host_interest') {
    return q[question.key] === HOST_INTERESTED_ANSWER;
  }
  if (question.type === 'array') return !isEmpty(q[question.key]);
  return !isBlank(q[question.key]);
}

/**
 * @param {object} user Mongoose User doc or plain object
 * @returns {{percentage:number, completed:number, applicable:number, breakdown:object, missingFields:Array}}
 */
const calculateProfileCompletion = (user) => {
  if (!user) {
    return { percentage: 0, completed: 0, applicable: 0, breakdown: {}, missingFields: [] };
  }

  const q = user.questionnaire?.toObject?.() || user.questionnaire || {};
  const answeredIds = new Set((q.answeredProgressiveQuestionIds || []).map(Number));
  const isHost = q[HOST_INTEREST_QUESTION.key] === HOST_INTERESTED_ANSWER;

  const items = [];
  const add = (category, id, key, answered) => items.push({ category, id, key, answered });

  for (const question of ONBOARDING_QUESTIONS) {
    add('registration', question.id, question.key, isQuestionAnswered(question, q, answeredIds));
  }
  for (const question of PROFILE_QUESTIONS) {
    add('profile', question.id, question.key, isQuestionAnswered(question, q, answeredIds));
  }

  // The host gate is always asked, so it is always in the denominator.
  add('host', HOST_INTEREST_QUESTION.id, HOST_INTEREST_QUESTION.key,
    isQuestionAnswered(HOST_INTEREST_QUESTION, q, answeredIds));

  // 502-505 exist only for users who said yes. Someone not hosting is not
  // penalised for leaving host questions blank — they are simply not asked.
  if (isHost) {
    for (const question of HOST_CONDITIONAL_QUESTIONS) {
      add('host', question.id, question.key, isQuestionAnswered(question, q, answeredIds));
    }
  }

  // A real uploaded photo. Opening the picker or tapping "Add Profile Photo"
  // changes nothing here.
  add('photos', 'profilePhoto', 'profilePhoto', !isBlank(user.profilePhoto));

  // Authoritative verification state, NOT the questionnaire's "Yes, I'll verify
  // now" intent. There is no second verification state anywhere.
  add('verification', 'identityVerified', 'photoVerification',
    user.photoVerificationStatus === 'approved');

  // ── flat, equal-weight arithmetic ───────────────────────────────────────────
  const applicable = items.length;
  const completed = items.filter(i => i.answered).length;
  const percentage = applicable > 0
    ? Math.min(Math.max(Math.round((completed / applicable) * 100), 0), 100)
    : 0;

  // Breakdown keeps the previous category key names so existing clients keep
  // parsing; only the arithmetic changed.
  const breakdown = {};
  for (const category of ['registration', 'profile', 'photos', 'verification', 'host']) {
    const inCategory = items.filter(i => i.category === category);
    const filled = inCategory.filter(i => i.answered).length;
    breakdown[category] = {
      filled,
      total: inCategory.length,
      percentage: inCategory.length > 0 ? Math.round((filled / inCategory.length) * 100) : 100,
      // Each item is worth the same share of 100%; a category's influence is just
      // how many items it contains.
      weight: applicable > 0 ? Math.round((inCategory.length / applicable) * 1000) / 10 : 0,
      applicable: inCategory.length > 0,
    };
  }
  breakdown.host.hostMode = isHost;
  breakdown.overall = {
    percentage,
    totalFields: applicable,
    filledFields: completed,
  };

  const missingFields = items
    .filter(i => !i.answered)
    .map(i => ({ category: i.category, key: i.key, id: i.id }));

  return { percentage, completed, applicable, breakdown, missingFields };
};

module.exports = {
  calculateProfileCompletion,
  ONBOARDING_QUESTIONS,
  PROFILE_QUESTIONS,
  HOST_INTEREST_QUESTION,
  HOST_CONDITIONAL_QUESTIONS,
  HOST_INTERESTED_ANSWER,
  EXPLICIT_ANSWER_QUESTION_IDS,
  isQuestionAnswered,
};
