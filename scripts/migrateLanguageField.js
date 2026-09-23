/**
 * scripts/migrateLanguageField.js
 *
 * One-time migration: populate `questionnaire.preferredLanguages` for users
 * that only have the legacy `questionnaire.languagePreference` String field.
 *
 * Safety guarantees:
 *   - NEVER overwrites an existing preferredLanguages array (skips those users).
 *   - NEVER clears languagePreference (kept for backward compat reads).
 *   - Runs in batches of 500 to avoid memory pressure.
 *   - Dry-run mode prints what would change without writing anything.
 *
 * Usage:
 *   node scripts/migrateLanguageField.js           # live run
 *   node scripts/migrateLanguageField.js --dry-run # preview only
 *
 * Run once after deploying the new schema. Safe to re-run (idempotent).
 */

'use strict';
require('dotenv').config();

const mongoose = require('mongoose');
const User     = require('../models/User');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH   = 500;

async function migrate() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('❌  MONGODB_URI / MONGO_URI not set in environment.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('✅  Connected to MongoDB');
  if (DRY_RUN) console.log('ℹ️   DRY-RUN mode — no writes will be performed.\n');

  // ── Find all users who have a legacy languagePreference but NO preferredLanguages
  const query = {
    'questionnaire.languagePreference': { $exists: true, $ne: null, $ne: '' },
    $or: [
      { 'questionnaire.preferredLanguages': { $exists: false } },
      { 'questionnaire.preferredLanguages': { $size: 0 } },
      { 'questionnaire.preferredLanguages': null }
    ]
  };

  const total = await User.countDocuments(query);
  console.log(`🔍  Found ${total} user(s) to migrate.\n`);

  if (total === 0) {
    console.log('✨  Nothing to migrate. All done!');
    await mongoose.disconnect();
    return;
  }

  let processed = 0;
  let migrated  = 0;
  let errors    = 0;
  let skip      = 0;

  while (processed < total) {
    const batch = await User.find(query)
      .select('_id questionnaire.languagePreference questionnaire.preferredLanguages')
      .limit(BATCH)
      .lean();

    if (batch.length === 0) break;

    for (const user of batch) {
      processed++;
      const legacyLang = user.questionnaire?.languagePreference?.trim();

      if (!legacyLang) {
        skip++;
        continue;
      }

      // Normalise: "Both" → ["Hindi", "English"] (legacy "Both" option)
      let langs;
      if (legacyLang.toLowerCase() === 'both' ||
          legacyLang === 'English & Hindi' ||
          legacyLang === 'English & hindi') {
        langs = ['Hindi', 'English'];
      } else {
        langs = [legacyLang];
      }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] ${user._id}  "${legacyLang}" → ${JSON.stringify(langs)}`);
        migrated++;
        continue;
      }

      try {
        await User.findByIdAndUpdate(user._id, {
          $set: { 'questionnaire.preferredLanguages': langs }
        });
        migrated++;
        if (migrated % 100 === 0) {
          console.log(`  ✅  Migrated ${migrated} / ${total} …`);
        }
      } catch (err) {
        errors++;
        console.error(`  ❌  Failed for user ${user._id}: ${err.message}`);
      }
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`  Total found   : ${total}`);
  console.log(`  Migrated      : ${migrated}`);
  console.log(`  Skipped       : ${skip}`);
  console.log(`  Errors        : ${errors}`);
  if (DRY_RUN) console.log('\n  (DRY-RUN — nothing written)');
  console.log('─────────────────────────────────────────────\n');

  await mongoose.disconnect();
  console.log('🔌  Disconnected. Migration complete.');
}

migrate().catch(err => {
  console.error('❌  Migration failed:', err);
  mongoose.disconnect();
  process.exit(1);
});
