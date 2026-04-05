// jobs/movieDailySessionJob.js
// ─────────────────────────────────────────────────────────────────────────────
// TWO DAILY CRON TASKS:
//
// TASK 1 — Daily 7 PM check (runs every minute, fires once at 19:00)
//   If real-user nearby sessions <= 1 → create 3 system sessions for tomorrow:
//     11 AM · 3 PM · 7 PM
//   Uses the same generateSystemSessions() as the on-demand fallback,
//   so duplicate guard prevents double-creation.
//
// TASK 2 — Midnight label refresh (runs every minute, fires once at 00:00)
//   Does NOT recreate any sessions.
//   Simply logs that "Tomorrow" sessions are now "Today" sessions.
//   The Android client recomputes the label client-side from showTime,
//   so no DB write is needed — this task just produces a log confirmation
//   that the system is aware of the date change.
//
// TASK 3 — 7 PM re-check after expiry sweep
//   After the 8 PM expiry sweep has run (handled by movieSessionExpiryJob),
//   the daily job re-checks if any real sessions remain. If not, it generates
//   for the next day. This is the "After 7 PM → re-check" spec requirement.
//
// INTEGRATION:
//   Call startMovieDailySessionJob() from inside connectDB() in server.js,
//   alongside startMovieSessionExpiryJob().
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const MovieSession = require('../models/MovieSession');
const { generateSystemSessions, countNearbyRealUserSessions } = require('../services/movieSessionService');

// Track which hours we've already fired this task (resets each process restart)
// This prevents duplicate fires within the same minute window.
let _lastGenerationDate  = null;  // 'YYYY-MM-DD' of last generation run
let _lastMidnightDate    = null;  // 'YYYY-MM-DD' of last midnight log

// ─── Default centre-of-India coordinates for cityless generation ─────────────
// Used when no user lat/lng available (centre of Delhi)
const DEFAULT_LAT = 28.6139;
const DEFAULT_LNG = 77.2090;

// ─── User language pool for daily generation (no specific user context) ──────
const DAILY_LANG_CONTEXTS = [
  { languagePreference: 'Hindi'   },
  { languagePreference: 'English' },
  { languagePreference: 'Hindi'   },
];

// ─────────────────────────────────────────────────────────────────────────────
// startMovieDailySessionJob
// ─────────────────────────────────────────────────────────────────────────────
function startMovieDailySessionJob() {
  // Check every 60 seconds — but each task fires only once per day
  setInterval(async () => {
    try {
      const now   = new Date();
      const h     = now.getHours();
      const m     = now.getMinutes();
      const today = now.toLocaleDateString('en-CA');

      // ── TASK 1: 7 PM daily generation ─────────────────────────────────────
      // Fires in the window 19:00–19:01 (first 60s of 7 PM), once per day.
      if (h === 19 && m === 0 && _lastGenerationDate !== today) {
        _lastGenerationDate = today;
        await _runDailyGeneration('7PM-daily');
      }

      // ── TASK 2: Midnight label refresh ─────────────────────────────────────
      // Fires in the window 00:00–00:01, once per day.
      // "Tomorrow" sessions are now "Today" — no DB write needed,
      // the showTime field is already the correct absolute datetime.
      if (h === 0 && m === 0 && _lastMidnightDate !== today) {
        _lastMidnightDate = today;
        await _midnightRefresh(today);
      }

      // ── TASK 3: Post-8PM re-check ───────────────────────────────────────────
      // After the expiry sweep runs at 8 PM, check if real user sessions still
      // exist for tomorrow. If not, generate. Fires at 20:01 (one minute after
      // the expiry sweep's first 8 PM run).
      if (h === 20 && m === 1 && _lastGenerationDate !== today + '_post8pm') {
        _lastGenerationDate = today + '_post8pm';
        await _runDailyGeneration('post-8PM-recheck');
      }

    } catch (err) {
      console.error('[daily-session-job] error:', err.message);
    }
  }, 60_000);

  console.log('✅ Movie daily session job started (7PM generation + midnight refresh)');
}

// ─────────────────────────────────────────────────────────────────────────────
// _runDailyGeneration(trigger)
//
// Core logic: check real-user session count, generate if needed.
// ─────────────────────────────────────────────────────────────────────────────
async function _runDailyGeneration(trigger) {
  console.log(`\n📅 [daily-job] ${trigger} — checking real user sessions`);

  // Build a fake "loc" object for the count query
  // In production you could query against all major cities;
  // we use Delhi centre as the reference point.
  const loc = { lat: DEFAULT_LAT, lng: DEFAULT_LNG };

  const realCount = await countNearbyRealUserSessions(loc);
  console.log(`   Real-user sessions nearby: ${realCount}`);

  if (realCount <= 1) {
    console.log('   ≤1 real sessions — generating 3 system sessions for tomorrow');

    // Generate once per language context (3 sessions across 3 language slots)
    // generateSystemSessions() uses SYSTEM_SHOW_TIMES internally so all 3
    // slots are filled in a single call.
    const ctx     = DAILY_LANG_CONTEXTS[0]; // first context defines session[0] language
    const created = await generateSystemSessions(ctx, DEFAULT_LAT, DEFAULT_LNG);

    console.log(`📅 [daily-job] ${trigger} complete — ${created} session(s) created`);
  } else {
    console.log(`   ${realCount} real sessions exist — no generation needed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// _midnightRefresh(today)
//
// Logs that "Tomorrow" sessions are now "Today".
// Queries sessions whose showTime is today (formerly "tomorrow" sessions).
// No DB writes — showTime is already the correct absolute timestamp.
// The Android client derives the "Today / Tomorrow" label from showTime at runtime.
// ─────────────────────────────────────────────────────────────────────────────
async function _midnightRefresh(today) {
  console.log(`\n🌙 [daily-job] midnight refresh — ${today}`);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const todaysSessions = await MovieSession.find({
    status:   'active',
    showTime: { $gte: todayStart, $lte: todayEnd },
  }).lean();

  if (todaysSessions.length > 0) {
    console.log(`   ${todaysSessions.length} session(s) now show as "Today":`);
    todaysSessions.forEach(s => {
      const h = new Date(s.showTime).getHours();
      const label = h < 12 ? 'Morning (11 AM)' : h < 16 ? 'Afternoon (3 PM)' : 'Evening (7 PM)';
      console.log(`     • ${s.movieTitle} @ ${s.theatreName} — ${label}`);
    });
  } else {
    console.log('   No sessions scheduled for today.');
  }
}

module.exports = { startMovieDailySessionJob };
