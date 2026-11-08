// services/engagement/eligibility.js
// -----------------------------------------------------------------------------
// USER ELIGIBILITY ENGINE — pure functions over a lean User document.
//
// Uses the rules Humrah already applies; it adds none of its own:
//   account    status ACTIVE, not suspended (Sports/QC semantics), not banned, not
//              moderation-restricted, no deletion request, role USER (as the broadcast
//              audience query does).
//   devices    User.fcmTokens — the list logout removes tokens from. fcmDevices[] is not
//              used: a logged-out device's token stays there.
//   preference notifications.pushNotifications (master) and notifications.recommendations
//              ("Personalized recommendations" in Android Notification Settings) are the
//              global opt-out; each category maps to an existing toggle (below).
//   verification  not required in general (no existing rule requires it). SPORTS needs
//              it, because joining a plan does (sportsPlanService.isVerified).
//
// Android does not report the OS notification-permission state to the backend, so it
// cannot be checked here; FCM acceptance is therefore never treated as "displayed".
// -----------------------------------------------------------------------------
'use strict';

// Only the fields the engine reads. Never selects password, OTPs, sessions.
const USER_FIELDS = [
  '_id', 'role', 'status', 'suspensionInfo', 'banInfo', 'moderationFlags.restrictedUntil',
  'deletionRequestedAt', 'verified', 'photoVerificationStatus', 'notifications',
  'fcmTokens', 'blockedUsers', 'questionnaire.interests', 'questionnaire.hobbies',
  'questionnaire.conversationInterests', 'questionnaire.humrahRoomInterests',
  'liveLocation.coordinates', 'liveLocation.lat', 'liveLocation.lng', 'last_location_updated_at',
  'createdAt',
].join(' ');

// Category → the existing Notification Settings toggle that also governs it.
const PREFERENCE_BY_CATEGORY = Object.freeze({
  NEARBY: 'nearbyActivities',
  SPORTS: 'nearbyActivities',      // same toggle Sports discovery ("plan near you") uses
  COMMUNITY: 'communityActivity',
  ROOMS: 'communityActivity',
  INFORMATIVE: 'tips',
  SOCIAL: 'recommendations',
  FUNNY: 'recommendations',
  SEASONAL: 'recommendations',
});

const TOKEN_RE = /^[A-Za-z0-9_:\-.]{20,4096}$/;

const prefOff = (user, key) => !!(user && user.notifications && user.notifications[key] === false);

function isSuspended(user, now) {
  const s = user && user.suspensionInfo;
  if (!s || s.isSuspended !== true) return false;
  if (s.suspendedUntil && new Date(s.suspendedUntil).getTime() <= now) return false;
  return true;
}

/** Why this account may not receive any engagement notification, or null. */
function accountIssue(user, now = Date.now()) {
  if (!user) return 'USER_MISSING';
  if (user.deletionRequestedAt) return 'DELETION_REQUESTED';
  if (user.role && user.role !== 'USER') return 'NOT_USER_ROLE';
  if (user.status !== 'ACTIVE') return user.status === 'SUSPENDED' ? 'SUSPENDED' : 'NOT_ACTIVE';
  if (isSuspended(user, now)) return 'SUSPENDED';
  if (user.banInfo && user.banInfo.isBanned === true) return 'BANNED';
  const restrictedUntil = user.moderationFlags && user.moderationFlags.restrictedUntil;
  if (restrictedUntil && new Date(restrictedUntil).getTime() > now) return 'RESTRICTED';
  return null;
}

/** Valid-looking, de-duplicated FCM tokens of this account (all its devices). */
function deviceTokens(user) {
  const out = new Set();
  for (const t of (user && user.fcmTokens) || []) {
    if (typeof t !== 'string') continue;
    const s = t.trim();
    if (TOKEN_RE.test(s)) out.add(s);
  }
  return [...out];
}

function deviceIssue(user) {
  return deviceTokens(user).length === 0 ? 'NO_VALID_DEVICE' : null;
}

/** Global opt-outs. */
function globalPreferenceIssue(user) {
  if (prefOff(user, 'pushNotifications')) return 'PUSH_DISABLED';
  if (prefOff(user, 'recommendations')) return 'ENGAGEMENT_DISABLED';
  return null;
}

const isVerified = u => !!u && (u.verified === true || u.photoVerificationStatus === 'approved');

/** Category-level rules: the category's own toggle, and SPORTS' verification need. */
function categoryIssue(user, category) {
  const key = PREFERENCE_BY_CATEGORY[category];
  if (!key) return 'UNKNOWN_CATEGORY';
  if (prefOff(user, key)) return 'CATEGORY_DISABLED';
  if (category === 'SPORTS' && !isVerified(user)) return 'UNVERIFIED';
  return null;
}

/** Account + devices + global preference. Returns { eligible, reason }. */
function evaluateAccount(user, now = Date.now()) {
  const reason = accountIssue(user, now) || deviceIssue(user) || globalPreferenceIssue(user);
  return { eligible: reason === null, reason };
}

module.exports = {
  USER_FIELDS,
  PREFERENCE_BY_CATEGORY,
  accountIssue,
  deviceTokens,
  deviceIssue,
  globalPreferenceIssue,
  categoryIssue,
  evaluateAccount,
  isVerified,
  isSuspended,
};
