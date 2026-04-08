// jobs/movieDailySessionJob.js
// ─────────────────────────────────────────────────────────────────────────────
// DAILY CRON — three tasks, all city-aware:
//
// TASK 1 — 7 PM generation check  (19:00 IST = 13:30 UTC on Render)
//   For each city that has active users:
//     Count USER-created sessions for TOMORROW
//     IF user sessions >= 3 → do nothing (real users filled all slots)
//     IF user sessions < 3  → call generateSystemSessions() to fill missing slots
//   generateSystemSessions() uses slot-fill logic: only creates sessions for
//   slots that are still empty. Duplicate guard prevents double-creation.
//
// TASK 2 — Midnight label refresh  (00:00 IST = 18:30 UTC previous day)
//   No DB writes. Logs "Tomorrow → Today" transition.
//   Android computes labels from showTime at runtime.
//
// TASK 3 — Post-8PM re-check  (20:01 IST = 14:31 UTC)
//   After the 8 PM expiry sweep, re-check if real sessions exist for tomorrow.
//   If not, fill missing slots.
//
// TIMEZONE: Render runs UTC. All hour checks compare against IST hour.
//   IST hour = UTC hour + 5 (taking floor; +30min handled by minute check).
//   7 PM IST = 13:30 UTC → h_utc===13 && m_utc>=30 && m_utc<31
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const MovieSession = require('../models/MovieSession');
const { generateSystemSessions, countNearbyRealUserSessions } = require('../services/movieSessionService');

// Once-per-day fire guards
let _lastGenerationDate = null;
let _lastMidnightDate   = null;

// ─── Fallback: Delhi centre (used when no city coords available) ─────────────
const DEFAULT_LAT = 28.6139;
const DEFAULT_LNG = 77.2090;
const DEFAULT_CITY = 'delhi';

// ─────────────────────────────────────────────────────────────────────────────
// startMovieDailySessionJob
// ─────────────────────────────────────────────────────────────────────────────
function startMovieDailySessionJob() {
  setInterval(async () => {
    try {
      const now     = new Date();
      const h_utc   = now.getUTCHours();
      const m_utc   = now.getUTCMinutes();

      // IST today string for guard keys
      const istNow  = new Date(now.getTime() + 5.5 * 3_600_000);
      const today   = istNow.toISOString().slice(0, 10); // YYYY-MM-DD IST

      // ── TASK 1: 7 PM IST = 13:30 UTC ──────────────────────────────────────
      if (h_utc === 13 && m_utc === 30 && _lastGenerationDate !== today) {
        _lastGenerationDate = today;
        await _runDailyGeneration('7PM-IST');
      }

      // ── TASK 2: Midnight IST = 18:30 UTC (previous calendar day) ──────────
      if (h_utc === 18 && m_utc === 30 && _lastMidnightDate !== today) {
        _lastMidnightDate = today;
        await _midnightRefresh(today);
      }

      // ── TASK 3: 8:01 PM IST = 14:31 UTC (post-expiry re-check) ───────────
      if (h_utc === 14 && m_utc === 31 && _lastGenerationDate !== today + '_post8pm') {
        _lastGenerationDate = today + '_post8pm';
        await _runDailyGeneration('post-8PM-IST');
      }

    } catch (err) {
      console.error('[daily-session-job] error:', err.message);
    }
  }, 60_000);

  console.log('✅ Movie daily session job started');
}

// ─────────────────────────────────────────────────────────────────────────────
// _runDailyGeneration(trigger)
//
// Spec:
//  IF user sessions for tomorrow >= 3 → do NOTHING
//  IF user sessions for tomorrow < 3  → fill missing slots only
//
// City-aware: queries per city. Falls back to Delhi if no cities found.
// ─────────────────────────────────────────────────────────────────────────────
async function _runDailyGeneration(trigger) {
  console.log(`\n📅 [daily-job] ${trigger}`);

  // Build tomorrow date string in IST
  const now          = new Date();
  const istNow       = new Date(now.getTime() + 5.5 * 3_600_000);
  const istTomorrow  = new Date(istNow.getTime() + 24 * 3_600_000);
  const tomorrowStr  = istTomorrow.toISOString().slice(0, 10);

  // Find all cities that have active sessions or users
  // Simplest approach: find distinct cities in the session collection
  const cities = await MovieSession.distinct('city', {
    status:   'active',
    city:     { $nin: ['', null] },
  });

  // Always include default city even if no sessions yet
  if (!cities.includes(DEFAULT_CITY)) cities.push(DEFAULT_CITY);

  console.log(`   Cities to process: ${cities.join(', ')}`);

  for (const city of cities) {
    // Count USER-created sessions for tomorrow in this city
    const userCount = await MovieSession.countDocuments({
      status:            'active',
      isSystemGenerated: false,
      date:              tomorrowStr,
      city,
    });

    console.log(`   [${city}] user sessions tomorrow: ${userCount}`);

    // Spec: IF user sessions >= 3 → do NOTHING
    if (userCount >= 3) {
      console.log(`   [${city}] ≥3 real sessions — skipping generation`);
      continue;
    }

    // IF < 3 → fill missing slots
    console.log(`   [${city}] <3 real sessions — filling missing slots`);
    const created = await generateSystemSessions(
      { languagePreference: 'Hindi', city },
      DEFAULT_LAT, DEFAULT_LNG
    );
    console.log(`   [${city}] ${created} slot(s) filled`);
  }

  console.log(`📅 [daily-job] ${trigger} complete\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// _midnightRefresh(today)
// No DB writes. Logs "Tomorrow" sessions that are now "Today".
// ─────────────────────────────────────────────────────────────────────────────
async function _midnightRefresh(today) {
  console.log(`\n🌙 [daily-job] midnight — ${today}`);

  const todaySessions = await MovieSession.find({
    status: 'active',
    date:   today,
  }).lean();

  if (todaySessions.length) {
    console.log(`   ${todaySessions.length} session(s) now show as "Today":`);
    todaySessions.forEach(s => {
      const h = new Date(s.showTime).getUTCHours() + 5; // rough IST hour
      const slot = h < 12 ? '11 AM' : h < 16 ? '3 PM' : '7 PM';
      console.log(`     • [${s.city}] ${s.movieTitle} — ${slot}`);
    });
  } else {
    console.log('   No sessions scheduled for today.');
  }
}

module.exports = { startMovieDailySessionJob };
