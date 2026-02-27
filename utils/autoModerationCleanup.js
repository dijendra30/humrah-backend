// utils/autoModerationCleanup.js
// ─────────────────────────────────────────────────────────────────────────────
// Scans ALL existing users for dirty bio/goodMeetupMeaning/vibeQuote fields.
// Designed to run:
//   1. Once at server startup (cleans historical data)
//   2. Daily via cron (catches anything that slipped through)
//
// Usage in server.js:
//   const { runStartupCleanup, scheduleDailyCleanup } = require('./utils/autoModerationCleanup');
//   await runStartupCleanup();
//   scheduleDailyCleanup();
// ─────────────────────────────────────────────────────────────────────────────

const cron = require('node-cron');
const User = require('../models/User');
const { moderateQuestionnaire } = require('../middleware/moderation');

let startupCleanupDone = false;

/**
 * Scan and clean all users in MongoDB.
 * - Hard violations: field wiped to "", user flagged + strike added
 * - Auto-clean: contact info stripped, cleaned value saved silently
 */
async function runCleanup(label = 'MANUAL') {
  console.log(`\n[AUTO-MODERATION] 🔍 Starting ${label} scan...`);

  const stats = {
    scanned: 0,
    usersFixed: 0,
    usersFlagged: 0,
    fieldsWiped: 0,
    fieldsCleaned: 0,
  };

  try {
    // Only fetch users who have at least one text field set
    const users = await User.find({
      $or: [
        { 'questionnaire.bio':               { $exists: true, $nin: ['', null] } },
        { 'questionnaire.goodMeetupMeaning':  { $exists: true, $nin: ['', null] } },
        { 'questionnaire.vibeQuote':          { $exists: true, $nin: ['', null] } },
      ],
      // Skip already-suspended accounts (already dealt with)
      status: { $nin: ['SUSPENDED', 'BANNED'] },
    }).select('_id questionnaire moderationFlags status suspensionInfo');

    stats.scanned = users.length;
    console.log(`[AUTO-MODERATION] Found ${users.length} users to scan`);

    for (const user of users) {
      const q = user.questionnaire?.toObject?.() || user.questionnaire || {};

      const { cleanedQuestionnaire, violations, errors } = await moderateQuestionnaire(q);

      if (violations.length === 0) continue;

      // Apply cleaned values
      user.questionnaire = { ...q, ...cleanedQuestionnaire };
      user.markModified('questionnaire');

      // Record strikes
      await user.addModerationStrike(violations, `AUTO_CLEANUP_${label}`);

      // Tally stats
      stats.usersFixed++;
      for (const v of violations) {
        if (v.reason === 'auto_cleaned') {
          stats.fieldsCleaned++;
        } else {
          stats.fieldsWiped++;
          stats.usersFlagged++;
        }
      }

      console.log(`[AUTO-MODERATION] ${errors.length > 0 ? '🚨 FLAGGED' : '🧹 CLEANED'} user ${user._id} | violations: ${violations.map(v => `${v.field}(${v.reason})`).join(', ')}`);
    }

  } catch (err) {
    console.error('[AUTO-MODERATION] ❌ Cleanup error:', err.message);
  }

  console.log(`[AUTO-MODERATION] ✅ ${label} complete:`, stats);
  return stats;
}

/**
 * Run once at server startup.
 * Skips if already run in this process (prevents double-run on hot reload).
 */
async function runStartupCleanup() {
  if (startupCleanupDone) return;
  startupCleanupDone = true;

  // Small delay so DB connection is fully ready
  setTimeout(async () => {
    await runCleanup('STARTUP');
  }, 5000);
}

/**
 * Schedule daily scan at 3:00 AM IST (21:30 UTC previous day).
 * Catches anything that slipped through during the day.
 */
function scheduleDailyCleanup() {
  // "30 21 * * *" = 21:30 UTC = 3:00 AM IST
  cron.schedule('30 21 * * *', async () => {
    console.log('[AUTO-MODERATION] ⏰ Daily cron cleanup triggered');
    await runCleanup('DAILY_CRON');
  });

  console.log('[AUTO-MODERATION] ✅ Daily cleanup cron scheduled (3:00 AM IST)');
}

module.exports = { runStartupCleanup, scheduleDailyCleanup, runCleanup };
