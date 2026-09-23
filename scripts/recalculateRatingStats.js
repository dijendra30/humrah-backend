/**
 * scripts/recalculateRatingStats.js
 *
 * Recomputes User.ratingStats from the rating collections that are the source of
 * truth: `meetupratings` (Surprise Activity feedback) and `reviews` (paid companion
 * bookings).
 *
 * Why it exists:
 *   ratingStats is only rebuilt when a NEW rating is submitted. Any rating that
 *   landed before the aggregate learned about a field - reviewTexts, for instance -
 *   leaves the user document stale until someone rates them again. This backfills.
 *   It is also the repair tool if a stats write ever fails: the route deliberately
 *   swallows that error so a failed aggregate cannot fail the user's submission.
 *
 * Safety guarantees:
 *   - Derives everything by reading. Nothing is incremented, so re-running cannot
 *     double-count. Running it twice produces the same result as running it once.
 *   - Only touches users who actually have at least one rating. A user nobody has
 *     rated is never written to.
 *   - Writes ONLY the ratingStats field. No other field on the document is read,
 *     modified or cleared.
 *   - Uses the same Review.calculateRatingStats the API uses, so the script and the
 *     live route can never disagree.
 *   - Dry-run prints every change without writing.
 *
 * Usage:
 *   node scripts/recalculateRatingStats.js --dry-run        # preview everything
 *   node scripts/recalculateRatingStats.js                  # apply to all rated users
 *   node scripts/recalculateRatingStats.js --user <userId>  # a single user
 */

'use strict';
require('dotenv').config();

const mongoose = require('mongoose');
const User     = require('../models/User');
const Review   = require('../models/Review');       // also registers MeetupRating
const MeetupRating = require('../models/MeetupRating');

const DRY_RUN  = process.argv.includes('--dry-run');
const userFlag = process.argv.indexOf('--user');
const ONE_USER = userFlag !== -1 ? process.argv[userFlag + 1] : null;

function summarise(s) {
  const d = s.starDistribution;
  return `avg=${s.averageRating} total=${s.totalRatings} completed=${s.completedBookings} ` +
         `stars=[5:${d.five} 4:${d.four} 3:${d.three} 2:${d.two} 1:${d.one}] ` +
         `texts=${s.reviewTexts ? s.reviewTexts.length : 0}`;
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI / MONGO_URI not set in environment.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');
  if (DRY_RUN) console.log('DRY-RUN — nothing will be written.\n');

  // Everyone who has been rated, from either source. Users with no ratings are
  // deliberately excluded rather than reset to zero.
  let ids;
  if (ONE_USER) {
    ids = [new mongoose.Types.ObjectId(ONE_USER)];
    console.log(`Single user: ${ONE_USER}\n`);
  } else {
    const [meetupIds, reviewIds] = await Promise.all([
      MeetupRating.distinct('revieweeId'),
      Review.distinct('revieweeId'),
    ]);
    const seen = new Map();
    for (const id of [...meetupIds, ...reviewIds]) seen.set(id.toString(), id);
    ids = [...seen.values()];
    console.log(`${ids.length} user(s) have at least one rating\n`);
  }

  let updated = 0, unchanged = 0, failed = 0;

  for (const id of ids) {
    try {
      const before = await User.findById(id).select('ratingStats firstName').lean();
      if (!before) {
        console.log(`  skip    ${id}  (user not found)`);
        continue;
      }

      const stats = await Review.calculateRatingStats(id);
      const same = JSON.stringify(before.ratingStats || {}) === JSON.stringify(stats);

      if (same) {
        unchanged++;
        continue;
      }

      console.log(`  ${DRY_RUN ? 'would ' : ''}update ${id} (${before.firstName || '?'})`);
      console.log(`     before: ${summarise(before.ratingStats || { starDistribution: {} })}`);
      console.log(`     after : ${summarise(stats)}`);
      if (stats.reviewTexts && stats.reviewTexts.length) {
        console.log(`     texts : ${JSON.stringify(stats.reviewTexts.slice(0, 3))}`);
      }

      if (!DRY_RUN) {
        await User.findByIdAndUpdate(id, { $set: { ratingStats: stats } });
      }
      updated++;
    } catch (err) {
      failed++;
      console.error(`  FAILED  ${id}: ${err.message}`);
    }
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} | already correct: ${unchanged} | failed: ${failed}`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}

run().catch(async err => {
  console.error('Fatal:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
