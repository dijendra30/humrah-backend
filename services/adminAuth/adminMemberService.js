// services/adminAuth/adminMemberService.js — owners add / change / remove limited dashboard members.
//
// Hardening (all server-side):
//   • owners only (ADMIN_ALLOWED_EMAILS + SUPER_ADMIN), dashboard cookie session + CSRF (route)
//   • a recent sign-in is required for every change (ADMIN_SENSITIVE_REAUTH_MINUTES, default 15)
//   • changes are rate limited per owner and capped in number
//   • owner emails and the owner code mailbox (ADMIN_OTP_DESTINATION) can never be members
//   • app-user (USER) and SUPER_ADMIN accounts are refused; a new staff account is created only
//     when no account exists for the email
//   • sections must come from the catalog; owner-only areas can't be granted
//   • removal ends that member's sessions and pending codes at once; every change is logged
'use strict';

const crypto = require('crypto');
const config = require('../../config/adminAuthConfig');
const AdminMember = require('../../models/AdminMember');
const AdminSession = require('../../models/AdminSession');
const AdminLoginChallenge = require('../../models/AdminLoginChallenge');
const { normaliseSections, catalog } = require('./adminPermissions');
const rateLimit = require('./adminAuthRateLimit');
const securityLog = require('./adminSecurityLog');

const MAX_ACTIVE_MEMBERS = 50;
const ID_RE = /^[a-f0-9]{24}$/;

const User = () => require('../../models/User');
const fail = (status, code, message, extra = {}) => ({ status, body: { success: false, code, message, ...extra } });
const actor = owner => ({ userId: owner._id, email: owner.email });

function present(m) {
  return {
    id: String(m._id),
    email: m.email,
    sections: m.sections || [],
    note: m.note || '',
    status: m.status,
    createdStaffAccount: !!m.createdStaffAccount,
    addedBy: m.addedBy?.email || null,
    addedAt: m.createdAt,
    updatedAt: m.updatedAt,
    removedBy: m.removedBy?.email || null,
    removedAt: m.removedAt || null,
  };
}

function cleanNote(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f<>]/g, '').trim();
  return t.length > 60 ? null : t;
}

/** Owner guard extras: recent sign-in + change rate. Returns a failure result or null. */
async function guardChange(owner, session, req) {
  const cfg = config.get();
  const ageMs = Date.now() - new Date(session.createdAt).getTime();
  if (ageMs > cfg.sensitiveReauthMs) {
    securityLog.record('REAUTH_REQUIRED', req, { email: owner.email, authorised: true, userId: owner._id });
    return fail(403, 'REAUTH_REQUIRED', 'For your security, sign in again before changing admin access.');
  }
  const lim = await rateLimit.hit('admin-member-change', String(owner._id), { max: 20, windowMs: 60 * 60 * 1000 });
  if (!lim.allowed) return fail(429, 'RATE_LIMITED', 'Too many access changes. Please wait and try again.', { retryAfterSeconds: lim.retryAfterSeconds });
  return null;
}

function refused(req, owner, code, message, email) {
  securityLog.record('ADMIN_MEMBER_CHANGE_REFUSED', req, { email: owner.email, authorised: true, userId: owner._id, details: { code, member: email ? String(email).slice(0, 120) : undefined } });
  return fail(code === 'MEMBER_NOT_FOUND' ? 404 : 409, code, message);
}

async function endAccess(member, reason) {
  await AdminSession.updateMany({ userId: member.userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
  await AdminLoginChallenge.updateMany({ email: member.email, status: 'PENDING' }, { $set: { status: 'SUPERSEDED', closedAt: new Date() } });
}

// ─────────────────────────────────────────────────────────────────────────────
async function list() {
  const cfg = config.get();
  const members = await AdminMember.find({}).sort({ status: 1, createdAt: -1 }).limit(200).lean();
  const ownerEmails = [...cfg.allowedEmails];
  const ownerUsers = await User().find({ email: { $in: ownerEmails } }).select('email role status').lean();
  const owners = ownerEmails.map(email => {
    const u = ownerUsers.find(x => x.email === email);
    return { email, role: u ? u.role : null, status: u ? u.status : 'NO_ACCOUNT' };
  });
  return { status: 200, body: { success: true, owners, members: members.map(present), sections: catalog(), maxMembers: MAX_ACTIVE_MEMBERS } };
}

async function add(owner, session, body, req) {
  const cfg = config.get();
  const guard = await guardChange(owner, session, req);
  if (guard) return guard;

  const rawEmail = typeof body?.email === 'string' ? body.email : '';
  const email = config.normEmail(rawEmail);
  if (rawEmail.length > 254 || !config.EMAIL_RE.test(email)) return fail(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  const sections = normaliseSections(body?.sections);
  if (!sections) return fail(400, 'INVALID_SECTIONS', 'Choose at least one section.');
  const note = cleanNote(body?.note);
  if (note === null) return fail(400, 'INVALID_NOTE', 'Label: up to 60 characters.');

  if (cfg.allowedEmails.has(email)) return refused(req, owner, 'EMAIL_IS_OWNER', 'This email already has full access through the server configuration.', email);
  if (email === cfg.otpDestination) {
    return refused(req, owner, 'EMAIL_IS_CODE_MAILBOX', 'This mailbox receives the owner sign-in codes, so it cannot be a limited member. Use a different email or change ADMIN_OTP_DESTINATION.', email);
  }

  const existing = await AdminMember.findOne({ email });
  if (existing && existing.status === 'ACTIVE') return refused(req, owner, 'MEMBER_EXISTS', 'This email is already a member. Edit it instead.', email);
  const activeCount = await AdminMember.countDocuments({ status: 'ACTIVE' });
  if (activeCount >= MAX_ACTIVE_MEMBERS) return refused(req, owner, 'MEMBER_LIMIT', `You can have at most ${MAX_ACTIVE_MEMBERS} members.`, email);

  let user = await User().findOne({ email }).select('-password');
  let createdStaffAccount = existing ? !!existing.createdStaffAccount : false;
  if (user) {
    const role = String(user.role || '').toUpperCase();
    if (role === 'SUPER_ADMIN') return refused(req, owner, 'ACCOUNT_IS_SUPER_ADMIN', 'This account is a super admin. Limited access can only be given to a separate staff email.', email);
    if (role !== 'SAFETY_ADMIN') {
      // created by us earlier and later demoted by someone? only re-promote accounts we created
      if (!(existing && existing.createdStaffAccount && String(existing.userId) === String(user._id))) {
        return refused(req, owner, 'ACCOUNT_IS_APP_USER', 'This email belongs to an app user account. Use a dedicated staff email instead.', email);
      }
      user.role = 'SAFETY_ADMIN';
      await user.save();
    }
    if (user.status && user.status !== 'ACTIVE') return refused(req, owner, 'ACCOUNT_INACTIVE', 'This account is suspended or inactive.', email);
  } else {
    // A staff account that can't be signed into with a password (random, never shown).
    user = new (User())({
      firstName: 'Humrah',
      lastName: 'Staff',
      email,
      password: crypto.randomBytes(24).toString('base64url') + 'Aa1!',
      role: 'SAFETY_ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
    });
    await user.save();
    createdStaffAccount = true;
  }

  const doc = await AdminMember.findOneAndUpdate(
    { email },
    {
      $set: { email, userId: user._id, sections, note, status: 'ACTIVE', createdStaffAccount, updatedBy: actor(owner), removedBy: null, removedAt: null },
      $setOnInsert: { addedBy: actor(owner) },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (existing) await AdminMember.updateOne({ _id: doc._id }, { $set: { addedBy: actor(owner) } });

  securityLog.record('ADMIN_MEMBER_ADDED', req, { email: owner.email, authorised: true, userId: owner._id, details: { member: email, sections, createdStaffAccount } });
  return { status: 201, body: { success: true, member: present(await AdminMember.findById(doc._id).lean()) } };
}

async function update(owner, session, id, body, req) {
  const guard = await guardChange(owner, session, req);
  if (guard) return guard;
  if (!ID_RE.test(String(id))) return fail(400, 'INVALID_ID', 'Unknown member.');
  const m = await AdminMember.findById(id);
  if (!m || m.status !== 'ACTIVE') return refused(req, owner, 'MEMBER_NOT_FOUND', 'This member does not exist or was removed.', m && m.email);

  const sections = body?.sections === undefined ? m.sections : normaliseSections(body.sections);
  if (!sections) return fail(400, 'INVALID_SECTIONS', 'Choose at least one section.');
  const note = body?.note === undefined ? m.note : cleanNote(body.note);
  if (note === null) return fail(400, 'INVALID_NOTE', 'Label: up to 60 characters.');

  const previous = m.sections.slice();
  m.sections = sections;
  m.note = note;
  m.updatedBy = actor(owner);
  await m.save();
  securityLog.record('ADMIN_MEMBER_UPDATED', req, { email: owner.email, authorised: true, userId: owner._id, details: { member: m.email, sections, previousSections: previous } });
  return { status: 200, body: { success: true, member: present(m.toObject()) } };
}

async function remove(owner, session, id, req) {
  const guard = await guardChange(owner, session, req);
  if (guard) return guard;
  if (!ID_RE.test(String(id))) return fail(400, 'INVALID_ID', 'Unknown member.');
  const m = await AdminMember.findById(id);
  if (!m || m.status !== 'ACTIVE') return refused(req, owner, 'MEMBER_NOT_FOUND', 'This member does not exist or was already removed.', m && m.email);
  m.status = 'REMOVED';
  m.removedBy = actor(owner);
  m.removedAt = new Date();
  await m.save();
  await endAccess(m, 'MEMBER_REMOVED');
  securityLog.record('ADMIN_MEMBER_REMOVED', req, { email: owner.email, authorised: true, userId: owner._id, details: { member: m.email } });
  return { status: 200, body: { success: true, member: present(m.toObject()) } };
}

module.exports = { list, add, update, remove, MAX_ACTIVE_MEMBERS };
