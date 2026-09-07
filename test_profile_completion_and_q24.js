// test_profile_completion_and_q24.js
// Pre-launch bug fix: Q24 completion semantics + item-based profile completion.
// Run: node test_profile_completion_and_q24.js
'use strict';

const fs = require('fs');
const {
  calculateProfileCompletion,
  ONBOARDING_QUESTIONS, PROFILE_QUESTIONS,
  HOST_INTEREST_QUESTION, HOST_CONDITIONAL_QUESTIONS, HOST_INTERESTED_ANSWER,
} = require('./utils/profileCompletion');
const { getUnansweredProgressive, markProgressiveAnswered } = require('./routes/users')._q24;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`[PASS] ${n}`); } else { fail++; console.log(`[FAIL] ${n}`); } };

const user = (q = {}, extra = {}) => ({ questionnaire: q, ...extra });
const pct = (q, extra) => calculateProfileCompletion(user(q, extra)).percentage;
const calc = (q, extra) => calculateProfileCompletion(user(q, extra));

const answerAllOnboarding = (over = {}) => {
  const q = { answeredProgressiveQuestionIds: [24] };
  ONBOARDING_QUESTIONS.forEach(x => {
    if (x.id === 24) return; // explicit marker above
    q[x.key] = x.type === 'array' ? ['x'] : 'x';
  });
  return { ...q, ...over };
};

const NON_HOST_APPLICABLE = ONBOARDING_QUESTIONS.length + PROFILE_QUESTIONS.length + 1 /*501*/ + 1 /*photo*/ + 1 /*verify*/;
const HOST_APPLICABLE = NON_HOST_APPLICABLE + HOST_CONDITIONAL_QUESTIONS.length;

(() => {
  // ═══ Q24 SEMANTICS ═════════════════════════════════════════════════════════
  ok('18. Room-created topic alone does NOT complete Q24 (progressive)',
    getUnansweredProgressive({ humrahRoomInterests: ['Food & Cooking'] }).some(p => p.id === 24));

  ok('18b. …and does NOT count toward profile completion', (() => {
    const c = calc({ humrahRoomInterests: ['Food & Cooking'] });
    return c.missingFields.some(m => m.id === 24);
  })());

  ok('19. an explicit Q24 answer completes it', (() => {
    const q = { humrahRoomInterests: ['Food & Cooking'] };
    markProgressiveAnswered(q, 24);
    return !getUnansweredProgressive(q).some(p => p.id === 24) &&
      !calc(q).missingFields.some(m => m.id === 24);
  })());

  ok('20. an existing backfilled marker keeps Q24 complete',
    !getUnansweredProgressive({ answeredProgressiveQuestionIds: [24] }).some(p => p.id === 24));

  ok('C. a completed Q24 never reappears',
    getUnansweredProgressive({ answeredProgressiveQuestionIds: [24], humrahRoomInterests: [] })
      .filter(p => p.id === 24).length === 0);

  ok('E. other progressive questions keep the field-emptiness rule',
    getUnansweredProgressive({ city: 'Delhi' }).some(p => p.id === 2) === false &&
    getUnansweredProgressive({}).some(p => p.id === 2) === true);

  ok('F. Room topic sync path is untouched (controller still uses $addToSet)',
    fs.readFileSync('controllers/roomController.js', 'utf8')
      .includes("$addToSet: { 'questionnaire.humrahRoomInterests': topic }"));

  // THE FIX: answering Q24 with a value equal to the stored Room topic.
  ok('BUG 1 ROOT CAUSE: the marker no longer depends on the value CHANGING',
    fs.readFileSync('routes/users.js', 'utf8')
      .includes('if (Array.isArray(incomingUpdates.humrahRoomInterests) &&'));
  ok('  …and the old change-gated form is gone',
    !fs.readFileSync('routes/users.js', 'utf8')
      .includes('if (Array.isArray(changedQuestionnaire.humrahRoomInterests) &&'));

  // THE ACTUAL PRODUCTION CAUSE: PUT /api/users/me replaced the whole
  // questionnaire subdocument with the client's object, wiping every server-owned
  // field the app does not send — including the Q24 marker — on each profile save.
  ok('BUG 1c ROOT CAUSE: PUT /me merges instead of replacing the questionnaire', (() => {
    const s = fs.readFileSync('routes/users.js', 'utf8');
    return s.includes('const mergedQ = { ...existingQ, ...cleanedQuestionnaire };') &&
      !/filteredUpdates\.questionnaire = cleanedQuestionnaire;/.test(s);
  })());
  ok('BUG 1c: PUT /me explicitly preserves server-owned progressive state', (() => {
    const s = fs.readFileSync('routes/users.js', 'utf8');
    return s.includes('mergedQ.answeredProgressiveQuestionIds = Array.isArray(existingQ.answeredProgressiveQuestionIds)') &&
      s.includes('mergedQ.nextProgressiveQuestionAvailableAt = existingQ.nextProgressiveQuestionAvailableAt');
  })());
  ok('BUG 1c: a client payload without the marker no longer clears it', (() => {
    // Reproduces the merge exactly as the route performs it.
    const existingQ = { humrahRoomInterests: ['Food & Cooking'], answeredProgressiveQuestionIds: [24], city: 'Delhi' };
    const clientPayload = { humrahRoomInterests: ['Food & Cooking'], city: 'Delhi', bio: 'hi' };
    const mergedQ = { ...existingQ, ...clientPayload };
    mergedQ.answeredProgressiveQuestionIds = Array.isArray(existingQ.answeredProgressiveQuestionIds)
      ? existingQ.answeredProgressiveQuestionIds : [];
    return !getUnansweredProgressive(mergedQ).some(p => p.id === 24) && mergedQ.bio === 'hi';
  })());
  ok('BUG 1c: the old whole-subdocument replace DID wipe it (the bug was real)', (() => {
    const clientPayload = { humrahRoomInterests: ['Food & Cooking'], city: 'Delhi' };
    return getUnansweredProgressive(clientPayload).some(p => p.id === 24);
  })());
  ok('BUG 1c: PUT /me also records an explicit Q24 answer',
    fs.readFileSync('routes/users.js', 'utf8').includes('markProgressiveAnswered(mergedQ, 24)'));

  ok('BUG 1b: the backfill can no longer re-run on every restart',
    fs.readFileSync('jobs/backfillQ24Completion.js', 'utf8').includes('Q24_BACKFILL_ENABLED') &&
    require('./jobs/backfillQ24Completion').BACKFILL_ENABLED === false);

  // ═══ COMPLETION: BASELINE + ONBOARDING ═════════════════════════════════════
  ok('1. an empty profile is 0%', pct({}) === 0);

  ok('1b. the denominator is item-based, not category-weighted',
    calc({}).applicable === NON_HOST_APPLICABLE);

  ok('2. one onboarding answer adds exactly one item', (() => {
    const c = calc({ city: 'Delhi' });
    return c.completed === 1 && c.percentage === Math.round((1 / NON_HOST_APPLICABLE) * 100);
  })());

  ok('3. multiple onboarding answers scale linearly', (() => {
    const c = calc({ city: 'Delhi', gender: 'F', movieGenre: 'Drama' });
    return c.completed === 3;
  })());

  ok('4. all onboarding answered credits every onboarding item', (() => {
    const c = calc(answerAllOnboarding());
    return c.breakdown.registration.filled === ONBOARDING_QUESTIONS.length &&
      c.completed === ONBOARDING_QUESTIONS.length;
  })());

  ok('NOT the old formula: onboarding is not a flat 40% baseline',
    calc(answerAllOnboarding()).percentage !== 40);

  ok('the old 40/30/10/10/10 weighting is gone',
    !fs.readFileSync('utils/profileCompletion.js', 'utf8').includes('CATEGORY_BASE_WEIGHTS'));

  // ═══ COMPLETION: PROFILE SECTION, PER QUESTION ═════════════════════════════
  ok('5. one profile question credits ONE item, not a whole section', (() => {
    const c = calc({ bio: 'hi' });
    return c.completed === 1 && c.breakdown.profile.filled === 1;
  })());

  ok('6. two questions in the same section credit two items',
    calc({ bio: 'hi', vibeQuote: 'x' }).breakdown.profile.filled === 2);

  ok('7. all questions in a section credit all of them',
    calc({ bio: 'a', goodMeetupMeaning: 'b', vibeQuote: 'c' }).breakdown.profile.filled === 3);

  ok('8. questions across multiple sections accumulate independently', (() => {
    const c = calc({ bio: 'a', city: 'Delhi' });
    return c.breakdown.profile.filled === 1 && c.breakdown.registration.filled === 1 && c.completed === 2;
  })());

  // ═══ HOST / COMPANION ══════════════════════════════════════════════════════
  ok('9. host "Yes, I\'m interested" completes the host-interest item', (() => {
    const c = calc({ becomeCompanion: HOST_INTERESTED_ANSWER });
    return c.breakdown.host.filled === 1 && c.breakdown.host.hostMode === true;
  })());

  ok('9b. …and pulls 502-505 into the denominator',
    calc({ becomeCompanion: HOST_INTERESTED_ANSWER }).applicable === HOST_APPLICABLE);

  ok('10. "Maybe later" does NOT complete the host item', (() => {
    const c = calc({ becomeCompanion: 'Maybe later' });
    return c.breakdown.host.filled === 0 && c.applicable === NON_HOST_APPLICABLE;
  })());

  ok('11. "No, just looking for friends" does NOT complete it', (() => {
    const c = calc({ becomeCompanion: 'No, just looking for friends' });
    return c.breakdown.host.filled === 0 && c.applicable === NON_HOST_APPLICABLE;
  })());

  ok('11b. a non-host is never penalised for blank 502-505',
    calc({ becomeCompanion: 'No, just looking for friends' }).missingFields
      .filter(m => [502, 503, 504, 505].includes(m.id)).length === 0);

  ok('12. host + one conditional answer credits exactly two host items', (() => {
    const c = calc({ becomeCompanion: HOST_INTERESTED_ANSWER, openFor: ['Coffee'] });
    return c.breakdown.host.filled === 2 && c.applicable === HOST_APPLICABLE;
  })());

  ok('13. host + all conditional answers credits all five host items', (() => {
    const q = { becomeCompanion: HOST_INTERESTED_ANSWER };
    HOST_CONDITIONAL_QUESTIONS.forEach(x => { q[x.key] = x.type === 'array' ? ['x'] : 'x'; });
    return calc(q).breakdown.host.filled === 5;
  })());

  ok('13b. blank optional host fields are not silently counted as answered',
    calc({ becomeCompanion: HOST_INTERESTED_ANSWER, tagline: '   ' }).breakdown.host.filled === 1);

  // ═══ PHOTO / VERIFICATION ══════════════════════════════════════════════════
  ok('14. no profile photo is incomplete',
    calc({}).missingFields.some(m => m.key === 'profilePhoto'));
  ok('15. an actual profile photo completes that item',
    calc({}, { profilePhoto: 'https://cdn/x.jpg' }).breakdown.photos.filled === 1);
  ok('15b. a blank photo string does not count',
    calc({}, { profilePhoto: '   ' }).breakdown.photos.filled === 0);

  ok('16. an unverified user is incomplete',
    calc({}).breakdown.verification.filled === 0);
  ok('17. actual approved verification completes it',
    calc({}, { photoVerificationStatus: 'approved' }).breakdown.verification.filled === 1);
  ok('17b. the questionnaire "Yes, I\'ll verify now" answer does NOT verify anyone',
    calc({ verifyIdentity: "Yes, I'll verify now" }).breakdown.verification.filled === 0);
  ok('17c. a pending verification does not count',
    calc({}, { photoVerificationStatus: 'pending' }).breakdown.verification.filled === 0);

  // ═══ NO DOUBLE COUNTING ════════════════════════════════════════════════════
  ok('21. derived fields are not separate items (ageGroup/age vs dateOfBirth)', (() => {
    const c = calc({ dateOfBirth: '2000-01-01', age: 26, ageGroup: '25-34' });
    return c.completed === 1;
  })());
  ok('21b. hobbies/interests are one question, not two',
    calc({ hobbies: ['Music'], interests: ['Music'] }).completed === 1);
  ok('21c. preferredLanguages/languagePreference are one question',
    calc({ preferredLanguages: ['Hindi'], languagePreference: 'Hindi' }).completed === 1);
  ok('21d. meetupPreference is NOT an onboarding item',
    calc({ meetupPreference: 'Public places' }).completed === 0);
  ok('21e. legacy non-question fields are not items',
    calc({ hangoutPreferences: ['Cafe'], lookingForOnHumrah: ['Friends'], publicPlacesOnly: 'Yes', name: 'A' })
      .completed === 0);
  ok('21f. every item id is unique', (() => {
    const ids = calc(answerAllOnboarding({ becomeCompanion: HOST_INTERESTED_ANSWER }))
      .missingFields.map(m => String(m.id));
    return new Set(ids).size === ids.length;
  })());

  // ═══ BOUNDS ════════════════════════════════════════════════════════════════
  ok('22. 100% is reachable', (() => {
    const q = answerAllOnboarding({ becomeCompanion: HOST_INTERESTED_ANSWER });
    PROFILE_QUESTIONS.forEach(x => { q[x.key] = 'x'; });
    HOST_CONDITIONAL_QUESTIONS.forEach(x => { q[x.key] = x.type === 'array' ? ['x'] : 'x'; });
    const c = calc(q, { profilePhoto: 'p.jpg', photoVerificationStatus: 'approved' });
    return c.percentage === 100 && c.completed === c.applicable;
  })());

  ok('23. the percentage always stays within 0-100', (() => {
    const cases = [
      calc({}), calc(answerAllOnboarding()),
      calc({ becomeCompanion: HOST_INTERESTED_ANSWER }),
      calc({ bio: 'x' }, { profilePhoto: 'p', photoVerificationStatus: 'approved' }),
      calculateProfileCompletion(null),
      calculateProfileCompletion({}),
    ];
    return cases.every(c => c.percentage >= 0 && c.percentage <= 100 && Number.isInteger(c.percentage));
  })());

  ok('23b. null/empty user is handled without throwing',
    calculateProfileCompletion(null).percentage === 0 &&
    calculateProfileCompletion(undefined).percentage === 0);

  // ═══ CANONICAL: ONE FORMULA ════════════════════════════════════════════════
  ok('one canonical calculator — the model calls it and nothing else recomputes', (() => {
    const model = fs.readFileSync('models/User.js', 'utf8');
    return model.includes("require('../utils/profileCompletion')") &&
      model.includes('this.profileCompletion = result.percentage');
  })());
  // NOTE: an earlier form of this assertion flagged routes/adminDashboard.js and
  // routes/officialEvents.js. Both only build Mongo query filters against the
  // stored value (`filter.profileCompletion = { $gte: n }`) — they consume the
  // canonical number, they do not compute one. The assertion now looks for an
  // actual competing CALCULATION rather than any mention of the field.
  ok('no second completion formula exists in the backend', (() => {
    const offenders = [];
    for (const d of ['routes', 'controllers', 'services', 'utils', 'models']) {
      for (const f of fs.readdirSync(d)) {
        const path = `${d}/${f}`;
        if (!f.endsWith('.js') || path === 'utils/profileCompletion.js') continue;
        const s = fs.readFileSync(path, 'utf8');
        // A competing formula would either define its own calculator or derive a
        // percentage locally from questionnaire fields.
        if (/function calculateProfileComplet|const calculateProfileComplet\s*=\s*\(/.test(s)) offenders.push(path);
        if (/profileCompletion\s*=\s*[^;]*\/[^;]*\*\s*100/.test(s)) offenders.push(path);
        if (/CATEGORY_BASE_WEIGHTS/.test(s)) offenders.push(path);
      }
    }
    return offenders.length === 0;
  })());

  ok('every consumer of the canonical calculator reads .percentage', (() => {
    const consumers = [];
    for (const d of ['routes', 'controllers', 'services', 'utils', 'models', 'jobs']) {
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.js')) continue;
        const s = fs.readFileSync(`${d}/${f}`, 'utf8');
        if (/require\(['"]\.\.?\/(utils\/)?profileCompletion['"]\)/.test(s)) consumers.push([`${d}/${f}`, s]);
      }
    }
    // Consumers today: models/User.js (pre-save hook), routes/adminDashboard.js
    // (admin re-run), routes/profileAssistant.js (the score it quotes to the user).
    // The count is deliberately not pinned — what matters is that every consumer
    // reads the canonical .percentage rather than deriving its own number.
    return consumers.length >= 1 &&
      consumers.every(([, s]) => /calculateProfileCompletion\([^)]*\)/.test(s) && s.includes('.percentage'));
  })());

  ok('the profile assistant quotes the canonical score, not its own formula', (() => {
    const s = fs.readFileSync('routes/profileAssistant.js', 'utf8');
    return s.includes('calculateProfileCompletion(user).percentage') &&
      !s.includes('Math.round(((6 - missingFields.length) / 6) * 100)');
  })());

  ok('the admin restore endpoint no longer writes an object into a Number field', (() => {
    const s = fs.readFileSync('routes/adminDashboard.js', 'utf8');
    return !s.includes('profileCompletion: androidCalc') &&
      s.includes('profileCompletion: result.percentage');
  })());
  ok('the calculator exposes counts for debugging', (() => {
    const c = calc({ city: 'Delhi' });
    return typeof c.completed === 'number' && typeof c.applicable === 'number' &&
      Array.isArray(c.missingFields);
  })());
  ok('breakdown keeps the existing category keys so clients still parse', (() => {
    const b = calc({}).breakdown;
    return ['registration', 'profile', 'photos', 'verification', 'host', 'overall'].every(k => k in b);
  })());
  ok('no private data is emitted in the breakdown', (() => {
    const s = JSON.stringify(calc({ bio: 'my secret bio', city: 'Delhi' }));
    return !s.includes('my secret bio') && !s.includes('Delhi');
  })());

  // ═══ ITEM SET MATCHES THE KOTLIN SOURCE OF TRUTH ═══════════════════════════
  const KT = 'C:/Users/DIJENDRA/AndroidStudioProjects/Humrah/app/src/main/java/in/humrah/app/';
  ok('onboarding item set matches QuestionnaireData.kt exactly', (() => {
    const s = fs.readFileSync(KT + 'QuestionnaireData.kt', 'utf8');
    const keys = [...s.matchAll(/backendKey = "([^"]+)"/g)].map(m => m[1]);
    const mine = ONBOARDING_QUESTIONS.map(x => x.key);
    return keys.length === mine.length && keys.every(k => mine.includes(k));
  })());
  ok('profile item set matches ProfileQuestionsData.kt exactly', (() => {
    const s = fs.readFileSync(KT + 'ui/ProfileQuestionsData.kt', 'utf8');
    const keys = [...s.matchAll(/backendKey = "([^"]+)"/g)].map(m => m[1]);
    const mine = [...PROFILE_QUESTIONS, HOST_INTEREST_QUESTION, ...HOST_CONDITIONAL_QUESTIONS].map(x => x.key);
    return keys.length === mine.length && keys.every(k => mine.includes(k));
  })());
  ok('the host answer string matches the Kotlin option verbatim',
    fs.readFileSync(KT + 'ui/ProfileQuestionsData.kt', 'utf8').includes(HOST_INTERESTED_ANSWER));

  console.log(`\nTests completed: ${pass}/${pass + fail} passed.`);
  process.exit(fail > 0 ? 1 : 0);
})();
