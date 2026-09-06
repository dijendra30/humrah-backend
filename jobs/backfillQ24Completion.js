// jobs/backfillQ24Completion.js
// -----------------------------------------------------------------------------
// One-shot, idempotent backward-compatibility backfill for the Q24 completion fix.
//
// BEFORE the fix, Q24 ("humrahRoomInterests") was considered "answered" whenever
// the field was non-empty. AFTER the fix, Q24 is answered only when its id is in
// questionnaire.answeredProgressiveQuestionIds. Without this backfill EVERY existing
// user with a non-empty humrahRoomInterests would suddenly be re-prompted for Q24.
//
// The current data model CANNOT distinguish "genuinely answered Q24" from
// "field populated indirectly by Room creation" for historical users. The safest
// backward-compatible choice is therefore to grandfather ALL such users as
// "Q24 answered" (preserving the pre-fix status quo — nobody who currently does
// NOT see Q24 suddenly starts seeing it).
//
// Accepted, documented limitation: pre-fix users whose interests came ONLY from
// Room creation will not be prompted for Q24. Re-prompting genuine answerers is
// the worse outcome. Users created / mutated AFTER this backfill are handled
// correctly by the route logic and are unaffected.
//
// Runs once at startup. One updateMany. Idempotent ($ne guard + $addToSet).
// -----------------------------------------------------------------------------
'use strict';

const User = require('../models/User');

async function backfillQ24Completion() {
  try {
    const result = await User.updateMany(
      {
        'questionnaire.humrahRoomInterests.0': { $exists: true }, // non-empty array
        'questionnaire.answeredProgressiveQuestionIds': { $ne: 24 },
      },
      { $addToSet: { 'questionnaire.answeredProgressiveQuestionIds': 24 } }
    );
    const n = result.modifiedCount ?? result.nModified ?? 0;
    console.log(`[BACKFILL] Q24 completion grandfathered for ${n} existing user(s) with non-empty humrahRoomInterests.`);
  } catch (err) {
    console.error('[BACKFILL] Q24 completion backfill failed (non-fatal):', err.message);
  }
}

module.exports = { backfillQ24Completion };
