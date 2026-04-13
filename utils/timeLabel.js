// utils/timeLabel.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure utility functions for session display and time enforcement.
// No DB calls — safe to call anywhere.
//
// TIME RULES:
//   START_HOUR    = 9   (9 AM  — earliest session)
//   END_HOUR      = 20  (8 PM  — no sessions at or after this)
//   CUTOFF_HOUR   = 19  (7 PM)
//   CUTOFF_MINUTE = 30  (7:30 PM combined — creation cutoff)
//   TOMORROW_HOUR = 10  (10 AM — default start for next-day sessions)
// ─────────────────────────────────────────────────────────────────────────────

const START_HOUR     = 9;
const END_HOUR       = 20;
const CUTOFF_HOUR    = 19;
const CUTOFF_MINUTE  = 30;
const TOMORROW_HOUR  = 10;

// ─────────────────────────────────────────────────────────────────────────────
// getNextShowTime(offsetMinutes)
//
// Strict 4-rule logic per spec:
//  1. currentHour >= 20 (8 PM)  → tomorrow at 10 AM
//  2. currentHour < 9  (9 AM)   → today at 9 AM
//  3. else → candidate = now + offsetMinutes
//  4. if candidate hour >= 20   → tomorrow at 10 AM
// ─────────────────────────────────────────────────────────────────────────────
function getNextShowTime(offsetMinutes) {
  if (offsetMinutes === undefined) offsetMinutes = 30;

  const now         = new Date();
  const currentHour = now.getHours();

  // Rule 1: at or after 8 PM
  if (currentHour >= END_HOUR) {
    return _tomorrowAt(TOMORROW_HOUR, 0);
  }

  // Rule 2: before 9 AM
  if (currentHour < START_HOUR) {
    return _todayAt(START_HOUR, 0);
  }

  // Rule 3: normal hours — apply offset
  const candidate = new Date(now.getTime() + offsetMinutes * 60_000);

  // Rule 4: offset pushed us to or past 8 PM
  if (candidate.getHours() >= END_HOUR) {
    return _tomorrowAt(TOMORROW_HOUR, 0);
  }

  return candidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// _istHour() / _istMinute() — IST-safe time helpers
// Render servers run UTC. Always derive IST from UTC + 5:30.
// NEVER use getHours() / getMinutes() directly — those use server local time.
// ─────────────────────────────────────────────────────────────────────────────
function _istHour() {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).getUTCHours();
}
function _istMinute() {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).getUTCMinutes();
}

// ─────────────────────────────────────────────────────────────────────────────
// isCreationAllowed()
// Returns false after 7:30 PM IST — backend rejects new sessions for today.
// ─────────────────────────────────────────────────────────────────────────────
function isCreationAllowed() {
  const h = _istHour();
  const m = _istMinute();
  if (h > CUTOFF_HOUR) return false;
  if (h === CUTOFF_HOUR && m >= CUTOFF_MINUTE) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// isAfterEndHour()
// Returns true at or after 8 PM IST — all today’s sessions should be expired.
// ─────────────────────────────────────────────────────────────────────────────
function isAfterEndHour() {
  return _istHour() >= END_HOUR;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateShowTime(showTime)
// Used by createSession() to reject times outside the 9 AM–8 PM window.
// ─────────────────────────────────────────────────────────────────────────────
function validateShowTime(showTime) {
  const now  = new Date();
  const show = new Date(showTime);

  if (isNaN(show.getTime())) {
    return { valid: false, reason: 'Invalid date/time' };
  }
  if (show <= now) {
    return { valid: false, reason: 'Show time must be in the future' };
  }

  const hour = show.getHours();

  if (hour < START_HOUR) {
    return { valid: false, reason: 'Sessions cannot start before 9:00 AM' };
  }
  if (hour >= END_HOUR) {
    return { valid: false, reason: 'Sessions cannot start at or after 8:00 PM' };
  }

  return { valid: true, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// getTimeLabel(showTime) → urgency label for UI
//
// Labels are based on BOTH time-until AND the actual hour of the show,
// so "Tonight" is never shown for morning or afternoon sessions.
//
//  < 2 hrs away               → "⚡ Starting soon · In X mins"
//  same day, show hour < 12   → "☀️ This morning"
//  same day, show hour < 17   → "🌤️ This afternoon"
//  same day, show hour < 20   → "🌆 This evening"
//  same day (fallback)        → "🌆 Tonight"
//  tomorrow                   → "📅 Tomorrow"
//  else                       → formatted date
// ─────────────────────────────────────────────────────────────────────────────
function getTimeLabel(showTime) {
  const now     = new Date();
  const show    = new Date(showTime);
  const diffMs  = show - now;
  const diffHrs = diffMs / 3_600_000;

  if (diffHrs < 0) return '🔴 Passed';

  // < 2 hours away — show countdown regardless of time of day
  if (diffHrs < 2) {
    const minsLeft = Math.max(1, Math.round(diffMs / 60_000));
    return `⚡ Starting soon · In ${minsLeft} min${minsLeft !== 1 ? 's' : ''}`;
  }

  const today    = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const showHour = show.getHours();

  if (_sameDay(show, today)) {
    // Use the ACTUAL show hour to pick the right label
    if (showHour < 12)  return '☀️ This morning';
    if (showHour < 17)  return '🌤️ This afternoon';
    if (showHour < 20)  return '🌆 This evening';
    return '🌆 Tonight';
  }

  if (_sameDay(show, tomorrow)) return '📅 Tomorrow';

  return `📅 ${show.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// getParticipantDisplay(count, maxParticipants)
// ─────────────────────────────────────────────────────────────────────────────
function getParticipantDisplay(count, maxParticipants) {
  if (count === 0) {
    return { text: '👥 Be among the first to join', urgency: null };
  }

  const text    = `👥 ${count}/${maxParticipants} going`;
  let   urgency = null;

  if (count === 1)      urgency = '🔥 Someone just joined';
  else if (count === 2) urgency = '🔥 Filling fast';
  else if (count >= 3)  urgency = '⚠️ Almost full';

  return { text, urgency };
}

// ─────────────────────────────────────────────────────────────────────────────
// getPostSessionMessage(participantCount) → FCM notification copy
// ─────────────────────────────────────────────────────────────────────────────
function getPostSessionMessage(participantCount) {
  if (participantCount <= 1) {
    return "Your hangout didn't get any joins this time. Try again later.";
  }
  if (participantCount <= 2) {
    return "Only a few people joined this time. Try again with a different time.";
  }
  return "Your hangout was active 🎉 Hope you had a great time!";
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

function _todayAt(hour, minute) {
  if (minute === undefined) minute = 0;
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

function _tomorrowAt(hour, minute) {
  if (minute === undefined) minute = 0;
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d;
}

module.exports = {
  getNextShowTime,
  isCreationAllowed,
  isAfterEndHour,
  validateShowTime,
  getTimeLabel,
  getParticipantDisplay,
  getPostSessionMessage,
  START_HOUR,
  END_HOUR,
  CUTOFF_HOUR,
  CUTOFF_MINUTE,
  TOMORROW_HOUR,
};
