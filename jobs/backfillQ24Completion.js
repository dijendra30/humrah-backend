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
// BUGFIX — this was described as "one-shot" but was wired to run on EVERY server
// start, and it has no way to tell a pre-fix user from a new one. That made it
// actively harmful after its first run: a user who received a topic ONLY through
// Room creation (which must NOT complete Q24) was silently grandfathered as
// "answered" at the next restart, so Q24 disappeared for someone who never saw it.
//
// It is now gated behind Q24_BACKFILL_ENABLED, default OFF, following the same
// kill-switch convention as the other jobs. The grandfathering already ran against
// production, so the default is the correct steady state; set the flag to true only
// to re-run it deliberately against a database that has never had it applied.
//
// One updateMany. Idempotent ($ne guard + $addToSet).
// -----------------------------------------------------------------------------
'use strict';

const User = require('../models/User');

const BACKFILL_ENABLED =
  String(process.env.Q24_BACKFILL_ENABLED || 'false').trim().toLowerCase() === 'true';

async function backfillQ24Completion() {
  if (!BACKFILL_ENABLED) {
    console.log('[BACKFILL] Q24 completion backfill skipped (Q24_BACKFILL_ENABLED != true) — already applied.');
    return;
  }
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

module.exports = { backfillQ24Completion, BACKFILL_ENABLED };
