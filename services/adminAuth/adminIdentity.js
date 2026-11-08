// services/adminAuth/adminIdentity.js — who counts as an authorised dashboard administrator.
//
// Two keys, both server-side:
//   1. the normalised email is in ADMIN_ALLOWED_EMAILS, and
//   2. the existing User account with that email has an admin role (SAFETY_ADMIN / SUPER_ADMIN),
//      is ACTIVE, and is not suspended or banned.
// Removing either (env allowlist, role, status) revokes access on the very next request.
// Nothing the browser sends (role, flags, destination) is consulted.
'use strict';

const config = require('../../config/adminAuthConfig');

const ADMIN_ROLES = Object.freeze(['SAFETY_ADMIN', 'SUPER_ADMIN']);
const isAdminRole = role => ADMIN_ROLES.includes(String(role || '').toUpperCase());

const isAllowlisted = email => config.get().allowedEmails.has(config.normEmail(email));

/** Account-level checks on a loaded User document (or lean object). */
function accountEligible(user) {
  if (!user) return false;
  if (!isAdminRole(user.role)) return false;
  if (user.status && user.status !== 'ACTIVE') return false;
  if (user.suspensionInfo?.isSuspended) return false;
  if (user.banInfo?.isBanned) return false;
  // Deliberately NOT checking the phone-password lockout (user.isLocked): otherwise anyone could
  // lock the dashboard out by failing that admin's app password a few times.
  return true;
}

/** Lazily required so this module can be loaded before models are registered. */
const User = () => require('../../models/User');

/** The eligible admin User for an email, or null. */
async function findEligibleAdmin(email) {
  const e = config.normEmail(email);
  if (!isAllowlisted(e)) return null;
  const user = await User().findOne({ email: e }).select('-password');
  return accountEligible(user) ? user : null;
}

/** Re-check for an existing session: same account, still allowlisted, still eligible, same tokenVersion. */
function sessionStillAuthorised(user, session) {
  if (!user || !session) return false;
  if (String(user._id) !== String(session.userId)) return false;
  if (config.normEmail(user.email) !== session.email) return false;
  if (!isAllowlisted(user.email)) return false;
  if ((user.tokenVersion ?? 0) !== (session.tv ?? 0)) return false;
  return accountEligible(user);
}

function safeAdminProfile(user) {
  return {
    _id: String(user._id),
    id: String(user._id),
    email: user.email,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    role: user.role,
    isSuperAdmin: String(user.role).toUpperCase() === 'SUPER_ADMIN',
  };
}

module.exports = { ADMIN_ROLES, isAdminRole, isAllowlisted, accountEligible, findEligibleAdmin, sessionStillAuthorised, safeAdminProfile };
