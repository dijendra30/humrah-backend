// services/quickConnect/eligibility.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 4): the ONE server-side eligibility policy. REST uses it now;
// matching and signaling must use the same function later. Nothing here trusts the
// client: the user is loaded fresh from the database by id, and the id always comes
// from the authenticated principal (req.user / the verified socket token).
//
// Checks, in order (codes are safe to show; they never contain other users' data):
//   QUICK_CONNECT_DISABLED   feature switch off
//   ACCOUNT_INVALID          no such user
//   ACCOUNT_RESTRICTED       not ACTIVE, suspended, banned, moderation-restricted,
//                            or account deletion requested
//   SESSION_NOT_ALLOWED      admin-dashboard token (Quick Connect is phone-only)
//   AGE_NOT_ASSURED          date of birth missing/invalid/under 18, or no adult attestation
//   NOT_IN_BETA              not on QUICK_CONNECT_BETA_USER_IDS
//   VERIFICATION_REQUIRED    verification not approved by an admin
//   CONSENT_REQUIRED         current consent version not accepted (or none configured)
//   BUSY                     in an Agora call or another Quick Connect session
//
// AGE: Humrah has no authoritative age proof. The date of birth is self-declared and
// editable; questionnaire.age is a stored snapshot and is NOT used. For the closed beta
// the product owner chose (15 Oct 2026): computed age from the date of birth >= 18 AND
// the adult attestation AND admin-approved verification AND the operator allow-list
// (accounts the owner has personally checked). Empty allow-list = nobody passes.
// This is a beta control, not age verification; a real process is needed before launch.
//
// BUSY is advisory: the atomic reservation claim (services/quickConnect/sessions.js) is
// what actually prevents two calls at once.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const User = require('../../models/User');
const VoiceCall = require('../../models/VoiceCall');
const VoiceCallReservation = require('../../models/VoiceCallReservation');
const QuickConnectConsent = require('../../models/QuickConnectConsent');
const config = require('./config');
const sessions = require('./sessions');
const { DASHBOARD_SCOPE } = require('../../utils/sessionGuard');

const ADULT_AGE = 18;
const MAX_AGE = 120;
const IST_OFFSET_MS = 330 * 60 * 1000;
const USER_FIELDS = [
  'status', 'suspensionInfo', 'banInfo', 'moderationFlags.restrictedUntil',
  'deletionRequestedAt', 'questionnaire.dateOfBirth', 'questionnaire.isAdultConfirmed',
  'verificationStatus'
].join(' ');

/**
 * Parses the stored date of birth ("YYYY-MM-DD", or "DD/MM/YYYY" as some older writes
 * kept it). Returns {y, m, d} for a real calendar date, otherwise null.
 */
function parseDateOfBirth(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let y, m, d, match;
  if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [, y, m, d] = match.map(Number);
  else if ((match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) { d = Number(match[1]); m = Number(match[2]); y = Number(match[3]); }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Whole years of age today in India (IST), or null when the date is unusable or in the future. */
function ageFromDateOfBirth(value, now = Date.now()) {
  const dob = parseDateOfBirth(value);
  if (!dob) return null;
  const today = new Date(now + IST_OFFSET_MS);
  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1, td = today.getUTCDate();
  let age = ty - dob.y;
  if (tm < dob.m || (tm === dob.m && td < dob.d)) age--;
  if (age < 0 || age > MAX_AGE) return null;
  return age;
}

function accountRestricted(user, now) {
  if (user.status !== 'ACTIVE') return true;
  if (user.suspensionInfo && user.suspensionInfo.isSuspended) {
    const until = user.suspensionInfo.suspendedUntil;
    if (!until || new Date(until).getTime() > now) return true;
  }
  if (user.banInfo && user.banInfo.isBanned) return true;
  const restrictedUntil = user.moderationFlags && user.moderationFlags.restrictedUntil;
  if (restrictedUntil && new Date(restrictedUntil).getTime() > now) return true;
  if (user.deletionRequestedAt) return true;
  return false;
}

/**
 * @param {string|ObjectId} userId  the AUTHENTICATED user's id — never a client-supplied one
 * @param {object} [opts]
 * @param {object} [opts.auth]            req.auth / decoded token ({ scope })
 * @param {boolean} [opts.checkBusy=true]
 * @param {string}  [opts.ownSessionId]   the caller's own Quick Connect session (not "busy")
 * @param {number}  [opts.now]
 * @returns {Promise<{eligible: boolean, code: string, reasons: string[], consent: {requiredVersion: string|null, accepted: boolean}}>}
 */
async function evaluateEligibility(userId, opts = {}) {
  const { auth = null, checkBusy = true, ownSessionId = null, now = Date.now() } = opts;
  const requiredVersion = config.requiredConsentVersion();
  const result = (reasons, accepted = false) => ({
    eligible: reasons.length === 0,
    code: reasons.length === 0 ? 'OK' : reasons[0],
    reasons,
    consent: { requiredVersion, accepted }
  });

  if (!config.isEnabled()) return result(['QUICK_CONNECT_DISABLED']);
  if (!userId || !mongoose.isValidObjectId(userId)) return result(['ACCOUNT_INVALID']);

  const user = await User.findById(userId).select(USER_FIELDS).lean();
  if (!user) return result(['ACCOUNT_INVALID']);
  if (accountRestricted(user, now)) return result(['ACCOUNT_RESTRICTED']);
  if (auth && auth.scope === DASHBOARD_SCOPE) return result(['SESSION_NOT_ALLOWED']);

  const reasons = [];
  const q = user.questionnaire || {};
  const age = ageFromDateOfBirth(q.dateOfBirth, now);
  if (age === null || age < ADULT_AGE || q.isAdultConfirmed !== true) reasons.push('AGE_NOT_ASSURED');
  if (!config.betaUserIds().has(String(user._id))) reasons.push('NOT_IN_BETA');
  if (user.verificationStatus !== 'approved') reasons.push('VERIFICATION_REQUIRED');

  const accepted = !!requiredVersion &&
    !!(await QuickConnectConsent.exists({ userId: user._id, version: requiredVersion }));
  if (!accepted) reasons.push('CONSENT_REQUIRED');

  if (checkBusy && reasons.length === 0) {
    const busy =
      (await VoiceCallReservation.isHeld(user._id, ownSessionId)) ||
      (await sessions.hasOtherActiveSession(user._id, ownSessionId, { now })) ||
      (await VoiceCall.isUserOnCall(user._id));
    if (busy) reasons.push('BUSY');
  }
  return result(reasons, accepted);
}

module.exports = { evaluateEligibility, ageFromDateOfBirth, parseDateOfBirth, ADULT_AGE, accountRestricted, USER_FIELDS };
