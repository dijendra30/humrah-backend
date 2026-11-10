// utils/protectedProfileFields.js — questionnaire keys a user may NOT rewrite through the general
// profile-edit routes (Phase 4.3 security audit).
//
// dateOfBirth/age are set once at onboarding, where the 18+ check runs (PUT /users/me/questionnaire
// re-checks age whenever a date of birth is sent). The consent fields are compliance records, and
// the progressive-question fields drive profile completion. PUT /users/me and PUT /profile/me used
// to accept any questionnaire key, so a user could change their date of birth around the age gate,
// rewrite their consent record, or mark questions answered. The Android app never sends these keys
// on those routes (verified), so they are ignored silently — no client sees an error.
'use strict';

const PROTECTED_QUESTIONNAIRE_KEYS = Object.freeze([
  'dateOfBirth', 'age', 'isAdultConfirmed', 'consentAccepted', 'consentTimestamp',
  'answeredProgressiveQuestionIds', 'lastProgressiveQuestionAnsweredAt', 'nextProgressiveQuestionAvailableAt',
]);

/** Returns a copy without the protected keys (and the list of keys that were dropped). */
function withoutProtectedKeys(questionnaire) {
  if (!questionnaire || typeof questionnaire !== 'object' || Array.isArray(questionnaire)) return { clean: questionnaire, dropped: [] };
  const clean = { ...questionnaire };
  const dropped = [];
  for (const k of PROTECTED_QUESTIONNAIRE_KEYS) if (k in clean) { delete clean[k]; dropped.push(k); }
  return { clean, dropped };
}

module.exports = { PROTECTED_QUESTIONNAIRE_KEYS, withoutProtectedKeys };
