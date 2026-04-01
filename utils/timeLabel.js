// utils/timeLabel.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure utility functions for session display logic.
// No DB calls — safe to call anywhere.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getTimeLabel(showTime) → human label based on urgency
 *
 * Rules (per spec):
 *  < 2 hours  → "⚡ Starting soon"
 *  < 6 hours  → "🕒 Later today"
 *  Same day   → "🌆 Tonight"
 *  Tomorrow   → "📅 Tomorrow"
 *  Else       → formatted date string
 */
function getTimeLabel(showTime) {
  const now      = new Date();
  const show     = new Date(showTime);
  const diffMs   = show - now;
  const diffHrs  = diffMs / 3_600_000;

  if (diffHrs < 0) return '🔴 Passed';
  if (diffHrs < 2) return '⚡ Starting soon';
  if (diffHrs < 6) return '🕒 Later today';

  // Check if same calendar day
  const today    = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  if (_sameDay(show, today))    return '🌆 Tonight';
  if (_sameDay(show, tomorrow)) return '📅 Tomorrow';

  // Formatted date fallback
  return `📅 ${show.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
}

/**
 * getParticipantDisplay(count, maxParticipants)
 *
 * Returns { text, urgency } — both are UI strings.
 *
 * Rules (per spec):
 *  0 participants → "👥 Be among the first to join"  (no urgency)
 *  1              → "👥 1/Y going" + "🔥 Someone just joined"
 *  2              → "👥 2/Y going" + "🔥 Filling fast"
 *  3+             → "👥 N/Y going" + "⚠️ Almost full"
 *
 * IMPORTANT: count is always participants.length (real users).
 *            NEVER fake this number.
 */
function getParticipantDisplay(count, maxParticipants) {
  if (count === 0) {
    return {
      text:    '👥 Be among the first to join',
      urgency: null,
    };
  }

  const text = `👥 ${count}/${maxParticipants} going`;

  let urgency = null;
  if (count === 1)      urgency = '🔥 Someone just joined';
  else if (count === 2) urgency = '🔥 Filling fast';
  else if (count >= 3)  urgency = '⚠️ Almost full';

  return { text, urgency };
}

/**
 * getPostSessionMessage(participantCount) → notification copy
 *
 * Sent to session creator after expiry.
 */
function getPostSessionMessage(participantCount) {
  if (participantCount <= 1) {
    return "Your hangout didn't get any joins this time. Try again later.";
  }
  if (participantCount <= 2) {
    return "Only a few people joined this time. Try again with a different time.";
  }
  return "Your hangout was active 🎉 Hope you had a great time!";
}

// ── Internal ──────────────────────────────────────────────────────────────────
function _sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth()    === b.getMonth()
    && a.getDate()     === b.getDate();
}

module.exports = { getTimeLabel, getParticipantDisplay, getPostSessionMessage };
