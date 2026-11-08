// services/adminAuth/adminIdentity.js — who may use the Admin Dashboard, and with which sections.
//
// An account gets dashboard access through exactly one of:
//   • ADMIN_ALLOWED_EMAILS (server env)  → owner (role SUPER_ADMIN) or admin (role SAFETY_ADMIN): all sections
//   • an ACTIVE AdminMember record added by an owner → member: only the sections the owner granted
// and in every case the User account itself must be ACTIVE, not suspended/banned, with an admin role.
// Members are always SAFETY_ADMIN accounts. Everything is re-read on every request, so removing an
// email, a member, a section, a role or suspending the account takes effect immediately.
// Nothing the browser sends (role, flags, sections, destination) is consulted.
'use strict';

const config = require('../../config/adminAuthConfig');
const { SECTION_KEYS } = require('./adminPermissions');

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
const AdminMember = () => require('../../models/AdminMember');

const FULL = kind => Object.freeze({ kind, isOwner: kind === 'owner', sections: SECTION_KEYS.slice() });

/**
 * Dashboard access for an account, or null.
 * @returns {Promise<null | { kind:'owner'|'admin'|'member', isOwner:boolean, sections:string[], memberId?:string }>}
 */
async function accessForUser(user) {
  if (!accountEligible(user)) return null;
  const email = config.normEmail(user.email);
  if (isAllowlisted(email)) return FULL(String(user.role).toUpperCase() === 'SUPER_ADMIN' ? 'owner' : 'admin');
  const m = await AdminMember().findOne({ email }).lean();
  if (!m || m.status !== 'ACTIVE') return null;
  if (String(m.userId) !== String(user._id)) return null;
  if (String(user.role).toUpperCase() !== 'SAFETY_ADMIN') return null; // members can never be SUPER_ADMIN
  if (email === config.get().otpDestination) return null;             // the owner code mailbox is never a member
  const sections = (m.sections || []).filter(s => SECTION_KEYS.includes(s));
  if (!sections.length) return null;
  return { kind: 'member', isOwner: false, sections, memberId: String(m._id) };
}

/**
 * Phone (Android app) admin tokens. Accounts that are managed members — active OR removed — get
 * exactly their member access (none once removed), so the app can't be used to go around the
 * dashboard limits. Unmanaged admin accounts keep their existing role-based access.
 * @returns {Promise<{ managed:boolean, access:object|null }>}
 */
async function phoneAccess(user) {
  const email = config.normEmail(user && user.email);
  if (!email || isAllowlisted(email)) return { managed: false, access: null };
  const m = await AdminMember().findOne({ email }).select('_id').lean();
  if (!m) return { managed: false, access: null };
  return { managed: true, access: await accessForUser(user) };
}

/** The User of an authorised dashboard identity (owner, admin or member), or null. */
async function findEligibleAdmin(email) {
  const e = config.normEmail(email);
  const user = await User().findOne({ email: e }).select('-password');
  if (!user) return null;
  return (await accessForUser(user)) ? user : null;
}

/** Re-check for an existing session. Returns the access object, or null when the session must end. */
async function sessionAccess(user, session) {
  if (!user || !session) return null;
  if (String(user._id) !== String(session.userId)) return null;
  if (config.normEmail(user.email) !== session.email) return null;
  if ((user.tokenVersion ?? 0) !== (session.tv ?? 0)) return null;
  return accessForUser(user);
}

function safeAdminProfile(user, access) {
  return {
    _id: String(user._id),
    id: String(user._id),
    email: user.email,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    role: user.role,
    isSuperAdmin: String(user.role).toUpperCase() === 'SUPER_ADMIN',
    access: access ? { kind: access.kind, isOwner: access.isOwner, sections: access.sections } : null,
  };
}

module.exports = { ADMIN_ROLES, isAdminRole, isAllowlisted, accountEligible, accessForUser, phoneAccess, findEligibleAdmin, sessionAccess, safeAdminProfile };
