// jobs/movieDailySessionJob.js
// ─────────────────────────────────────────────────────────────────────────────
// DAILY CRON — the one automatic Movie Hangout movie per India calendar day.
//
// TASK 1 — 3 PM IST daily movie
//   At 3:00 PM Asia/Kolkata, ensureDailySystemSession() creates ONE system
//   session for TOMORROW (dailyKey = tomorrow's date, show 7 PM IST tomorrow).
//   Not per city, not per user.
//   Idempotent in the database (MovieSession.dailyKey, partial unique index):
//   a repeated tick, a restart or a second instance creates nothing more.
//   Catch-up: if the server was down at 3:00 PM, the first tick between
//   3:00 PM and 6:30 PM IST creates it (still for tomorrow); after that, that
//   day's generation is skipped (existing policy, unchanged).
//
// TASK 2 — Midnight label refresh  (00:00 IST)
//   No DB writes. Logs "Tomorrow → Today" transition.
//   Android computes labels from showTime at runtime.
//
// The old 7 PM / post-8 PM slot-fill (three system sessions per city for the next
// day) no longer runs, and Home no longer generates sessions on open.
//
// TIMEZONE: every hour/day check is computed in Asia/Kolkata (Intl), never in
// the server's own zone.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const MovieSession = require('../models/MovieSession');
const { ensureDailySystemSession, _indiaClock, DAILY_CREATE_HOUR } = require('../services/movieSessionService');

// Catch-up window end: 6:30 PM IST (the show is at 7 PM).
const CATCH_UP_END_MINUTES = 18 * 60 + 30;

let _dailyDoneFor     = null;   // IST date whose daily movie is settled (created or found)
let _dailyRunning     = false;
let _lastMidnightDate = null;   // TASK 2: midnight label refresh

/** True when `clock` (IST) is inside the daily-movie window: 3:00 PM ≤ t < 6:30 PM. */
function inDailyWindow(clock) {
  const minutes = clock.hour * 60 + clock.minute;
  return minutes >= DAILY_CREATE_HOUR * 60 && minutes < CATCH_UP_END_MINUTES;
}

/** One tick of TASK 1. Exported for tests. */
async function runDailyMovieTick(now = new Date(), opts = {}) {
  const clock = _indiaClock(now);
  if (!inDailyWindow(clock) || _dailyDoneFor === clock.dateKey || _dailyRunning) return null;
  _dailyRunning = true;
  try {
    const result = await ensureDailySystemSession({ ...opts, now });
    if (result.created || result.sessionId || result.reason === 'too-late') _dailyDoneFor = clock.dateKey;
    console.log(`🎬 [daily-movie] ${clock.dateKey} ${result.created ? 'created' : 'no new session'}` +
      `${result.reason ? ` (${result.reason})` : ''}`);
    return result;
  } finally {
    _dailyRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// startMovieDailySessionJob
// ─────────────────────────────────────────────────────────────────────────────
function startMovieDailySessionJob() {
  setInterval(async () => {
    try {
      const now   = new Date();
      const clock = _indiaClock(now);

      // ── TASK 1: 3 PM IST daily movie (with catch-up until 6:30 PM IST) ────
      await runDailyMovieTick(now);

      // ── TASK 2: Midnight IST ──────────────────────────────────────────────
      if (clock.hour === 0 && clock.minute === 0 && _lastMidnightDate !== clock.dateKey) {
        _lastMidnightDate = clock.dateKey;
        await _midnightRefresh(clock.dateKey);
      }
    } catch (err) {
      console.error('[daily-session-job] error:', err.message);
    }
  }, 60_000);

  console.log('✅ Movie daily session job started (one movie per day at 3 PM IST)');
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
      console.log(`     • [${s.city}] ${s.movieTitle} — ${s.time}`);
    });
  } else {
    console.log('   No sessions scheduled for today.');
  }
}

/** Tests only: forget the in-process "done" marker (simulates a restart). */
function _resetForTests() { _dailyDoneFor = null; _dailyRunning = false; }

module.exports = { startMovieDailySessionJob, runDailyMovieTick, inDailyWindow, _resetForTests };
