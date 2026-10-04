// services/questions/questionRules.js
// -----------------------------------------------------------------------------
// Ask a Question — the fixed rules, in one place (Phase 1 spec + Phase 2 brief).
// Stable keys are stored; labels are only for the app.
// -----------------------------------------------------------------------------
'use strict';

/** Kill switch. Default OFF: only the exact string "true" turns it on. Read on every request. */
const questionsEnabled = () => String(process.env.QUESTIONS_ENABLED || '').trim().toLowerCase() === 'true';

const CATEGORIES = Object.freeze([
  'CAFE_COFFEE', 'FOOD', 'WORK_STUDY', 'SPORTS_FITNESS', 'SHOPPING', 'EXPLORE_PLACES',
  'NATURE_OUTDOORS', 'TRAVEL', 'JUST_HANGOUT', 'ART_CULTURE', 'OTHER',
]);

const CATEGORY_LABELS = Object.freeze({
  CAFE_COFFEE: 'Café / Coffee', FOOD: 'Food', WORK_STUDY: 'Work / Study', SPORTS_FITNESS: 'Sports & Fitness',
  SHOPPING: 'Shopping', EXPLORE_PLACES: 'Explore / Places', NATURE_OUTDOORS: 'Nature / Outdoors', TRAVEL: 'Travel',
  JUST_HANGOUT: 'Just Hangout', ART_CULTURE: 'Art & Culture', OTHER: 'Other',
});

// Predefined tags only (no custom tags in the MVP). Global ones for every category, plus a few per category.
const GLOBAL_TAGS = Object.freeze(['RECOMMENDATIONS', 'BUDGET_FRIENDLY', 'OPEN_NOW', 'SPECIFIC_AREA']);
const CATEGORY_TAGS = Object.freeze({
  CAFE_COFFEE:    ['GOOD_FOR_WORK_WIFI', 'QUIET'],
  WORK_STUDY:     ['GOOD_FOR_WORK_WIFI', 'QUIET'],
  FOOD:           ['VEG_OPTIONS'],
  SPORTS_FITNESS: ['BEGINNER_FRIENDLY'],
});
const TAG_LABELS = Object.freeze({
  RECOMMENDATIONS: 'Recommendations', BUDGET_FRIENDLY: 'Budget friendly', OPEN_NOW: 'Open now', SPECIFIC_AREA: 'Specific area',
  GOOD_FOR_WORK_WIFI: 'Good for work / Wi-Fi', QUIET: 'Quiet', VEG_OPTIONS: 'Veg options', BEGINNER_FRIENDLY: 'Beginner friendly',
});
const tagsFor = category => [...GLOBAL_TAGS, ...(CATEGORY_TAGS[category] || [])];

// Viewer interests (questionnaire.interests) that mean a category is relevant to them. Only a
// light ranking signal; never eligibility.
const CATEGORY_INTEREST_WORDS = Object.freeze({
  CAFE_COFFEE:     ['coffee', 'cafe', 'café', 'tea'],
  FOOD:            ['food', 'foodie', 'cooking', 'eating', 'baking'],
  WORK_STUDY:      ['study', 'work', 'reading', 'books', 'startup', 'tech', 'coding'],
  SPORTS_FITNESS:  ['sport', 'fitness', 'gym', 'running', 'cricket', 'football', 'badminton', 'yoga', 'cycling', 'tennis'],
  SHOPPING:        ['shopping', 'fashion'],
  EXPLORE_PLACES:  ['explor', 'city', 'photography', 'heritage'],
  NATURE_OUTDOORS: ['nature', 'outdoor', 'trek', 'hiking', 'camping'],
  TRAVEL:          ['travel', 'trip', 'backpack'],
  ART_CULTURE:     ['art', 'music', 'culture', 'theatre', 'theater', 'dance', 'museum', 'poetry'],
  JUST_HANGOUT:    [],
  OTHER:           [],
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  QUESTION_MIN_CHARS:  10,      // graphemes, after normalisation
  QUESTION_MAX_CHARS:  180,
  QUESTION_MIN_LETTERS: 3,
  ANSWER_MIN_CHARS:    1,
  ANSWER_MAX_CHARS:    300,
  REPLY_MIN_CHARS:     1,
  REPLY_MAX_CHARS:     300,
  RAW_INPUT_MAX:       4000,    // UTF-16 units; anything longer is refused before any processing (300 graphemes of
                                //   multi-unit emoji still fit)
  MAX_TAGS:            3,
  QUESTION_TTL_MS:     DAY_MS,
  RADIUS_M:            10000,
  VIEWER_FRESH_MS:     DAY_MS,      // a viewer / answerer needs a location fix this recent
  ASKER_FRESH_MS:      6 * HOUR_MS, // an asker needs a fix this recent to post
  GRID_KM:             1,
  MAX_ACTIVE_PER_USER: 2,
  MAX_ANSWERS:         50,
  MAX_REPLIES:         20,
  HOME_MAX:            3,
  PAGE_MAX:            20,
  DISCOVERY_CANDIDATES: 200,        // nearest N considered for ranking: bounded memory
  DUPLICATE_THRESHOLD: 0.90,
  DUPLICATE_WINDOW_MS: DAY_MS,
  NEW_ACCOUNT_MS:      DAY_MS,
  EXPIRY_BATCH:        500,
});

// Rate limits: [windowSeconds, max]. New accounts (< 24 h) get half (at least 1).
const RATE = Object.freeze({
  question: [[3600, 3], [86400, 5]],
  answer:   [[3600, 20], [86400, 60]],
  reply:    [[3600, 30]],
});
const BURST = Object.freeze({ windowSeconds: 30, max: 5, cooldownSeconds: 60 });

// Question-creation-only restriction ladder: 1 h → 1 day → 2 days → 4 days → final (admin-controlled).
const RESTRICTION_STEPS_MS = Object.freeze([HOUR_MS, DAY_MS, 2 * DAY_MS, 4 * DAY_MS]);
const RESTRICTION_FINAL_LEVEL = RESTRICTION_STEPS_MS.length + 1;   // 5

// Coarse distance bands, never finer than 1 km and never an exact number.
const DISTANCE_BANDS = Object.freeze([
  { key: 'UNDER_1_KM', label: 'Nearby', maxM: 1000 },
  { key: 'KM_1_2',     label: '1–2 km', maxM: 2000 },
  { key: 'KM_2_5',     label: '2–5 km', maxM: 5000 },
  { key: 'KM_5_10',    label: '5–10 km', maxM: 10000 },
]);
const OUT_OF_RANGE_BAND = Object.freeze({ key: 'OVER_10_KM', label: '10+ km' });

function bandOf(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return null;
  const i = DISTANCE_BANDS.findIndex(b => meters < b.maxM);
  return i < 0 ? { ...OUT_OF_RANGE_BAND, index: DISTANCE_BANDS.length } : { key: DISTANCE_BANDS[i].key, label: DISTANCE_BANDS[i].label, index: i };
}

module.exports = {
  questionsEnabled, CATEGORIES, CATEGORY_LABELS, GLOBAL_TAGS, CATEGORY_TAGS, TAG_LABELS, tagsFor, CATEGORY_INTEREST_WORDS,
  LIMITS, RATE, BURST, RESTRICTION_STEPS_MS, RESTRICTION_FINAL_LEVEL, DISTANCE_BANDS, OUT_OF_RANGE_BAND, bandOf, HOUR_MS, DAY_MS,
};
