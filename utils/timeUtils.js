/**
 * utils/timeUtils.js
 * ─────────────────────────────────────────────────────────────
 * Pure helper functions for session time calculations.
 * No side effects — fully unit-testable.
 */

const THREE_HOURS_MS  = 3 * 60 * 60 * 1000;   // 10_800_000 ms
const FIVE_MINUTES_MS = 5 * 60 * 1000;          //    300_000 ms
const TWO_HOURS_MS    = 2 * 60 * 60 * 1000;    //  7_200_000 ms

/**
 * Returns true when startTime is:
 *   • in the future, AND
 *   • no more than 3 hours from now.
 */
function isWithinThreeHours(startTime) {
  const start = new Date(startTime).getTime();
  const now   = Date.now();
  return start > now && start - now <= THREE_HOURS_MS;
}

/**
 * Returns remaining seconds until session start.
 * Negative value means session has already started.
 */
function getRemainingTime(startTime) {
  return Math.floor((new Date(startTime).getTime() - Date.now()) / 1000);
}

/**
 * Returns the exact Date at which the session expires
 * (start_time + 5 minutes grace period).
 */
function calculateExpiryTime(startTime) {
  return new Date(new Date(startTime).getTime() + FIVE_MINUTES_MS);
}

/**
 * Returns true if now is past the session's expiry point.
 */
function isExpired(startTime) {
  return Date.now() > calculateExpiryTime(startTime).getTime();
}

/**
 * Returns true if the user's last created session falls
 * within the 2-hour anti-spam cooldown window.
 */
function isWithinSpamWindow(lastCreatedAt) {
  return Date.now() - new Date(lastCreatedAt).getTime() < TWO_HOURS_MS;
}

/**
 * Returns the Date when the user is next allowed to create a session.
 */
function nextAllowedCreateTime(lastCreatedAt) {
  return new Date(new Date(lastCreatedAt).getTime() + TWO_HOURS_MS);
}

module.exports = {
  isWithinThreeHours,
  getRemainingTime,
  calculateExpiryTime,
  isExpired,
  isWithinSpamWindow,
  nextAllowedCreateTime,
  THREE_HOURS_MS,
  FIVE_MINUTES_MS,
  TWO_HOURS_MS,
};
