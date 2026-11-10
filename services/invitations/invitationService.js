// services/invitations/invitationService.js — Universal Group Invitations.
//
// One service for invitation links to Humrah Rooms, Sports Plans and Movie Hangouts.
// Every type-specific rule lives in that feature's existing code, reached through
// the adapters in inviteTargets.js. This file adds only what is common to links:
//
//   • tokens: random, hashed at rest, looked up by a unique index
//   • lifetime: expiry (capped by the group's own end), revocation, optional max uses
//   • who may create a link (a current member; PRIVATE Rooms: the host)
//   • the public preview: an explicit allow-list — never ids, members, messages,
//     contacts, addresses or coordinates; the inviter is first name + photo only
//   • joins: inviter still a member, no block between joiner and inviter (or, for
//     Movie Hangouts, any participant), one use reserved atomically before the
//     group's own join runs and handed back if that join does not add the user
//
// Results are { status, body } so routes stay thin.
'use strict';

const GroupInvitation = require('../../models/GroupInvitation');
const User = require('../../models/User');
const { newToken, isWellFormed, hashToken } = require('./inviteToken');
const { adapterFor } = require('./inviteTargets');

const DAY = 24 * 60 * 60 * 1000;
const MIN_REMAINING_MS = 60 * 1000;
const MAX_USES_LIMIT = 100;

const PUBLIC_BASE = () => (process.env.INVITE_PUBLIC_BASE_URL || 'https://humrah.in').replace(/\/+$/, '');
const ASSET_BASE = () => (process.env.INVITE_ASSET_BASE_URL || 'https://api.humrah.in').replace(/\/+$/, '');
const linkFor = (token) => `${PUBLIC_BASE()}/join/${token}`;
const imageFor = (token) => `${ASSET_BASE()}/join/${token}/image.jpg`;

const STATUS = Object.freeze({
  INVALID_REQUEST: 400,
  INVALID_TYPE: 400,
  INVITE_INVALID: 404,
  INVITE_EXPIRED: 410,
  INVITE_REVOKED: 410,
  INVITE_EXHAUSTED: 410,
  GROUP_DELETED: 410,
  GROUP_ENDED: 410,
  GROUP_FULL: 409,
  JOIN_BUSY: 409,
  BLOCKED: 403,
  VERIFICATION_REQUIRED: 403,
  ACCOUNT_NOT_ELIGIBLE: 403,
  NOT_A_MEMBER: 403,
  HOST_ONLY: 403,
  NOT_ALLOWED: 403,
  JOIN_FAILED: 500,
});

const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'That request was not valid.',
  INVALID_TYPE: 'That kind of group cannot be shared.',
  INVITE_INVALID: 'This invite link is not valid.',
  INVITE_EXPIRED: 'This invite link has expired.',
  INVITE_REVOKED: 'This invite link is no longer active.',
  INVITE_EXHAUSTED: 'This invite link has been used the maximum number of times.',
  GROUP_DELETED: 'This group no longer exists.',
  GROUP_ENDED: 'This group has ended and is no longer accepting people.',
  GROUP_FULL: 'This group is full.',
  JOIN_BUSY: 'Could not join right now. Please try again.',
  BLOCKED: "You can't join this group.",
  VERIFICATION_REQUIRED: 'Only verified users can join this group. Complete your profile verification to continue.',
  ACCOUNT_NOT_ELIGIBLE: 'Your account cannot join groups right now.',
  NOT_A_MEMBER: 'Only members can invite people to this group.',
  HOST_ONLY: 'Only the host can invite people to this private Room.',
  NOT_ALLOWED: 'You cannot change this invite link.',
  JOIN_FAILED: 'Something went wrong. Please try again.',
});

const fail = (code, extra = {}) => ({
  status: STATUS[code] || 400,
  body: { success: false, code, message: MESSAGES[code] || MESSAGES.JOIN_FAILED, ...extra },
});

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const includesId = (list, id) => (list || []).some((x) => sameId(x, id));

function inviterPublic(u) {
  if (!u) return { firstName: 'A Humrah member', profilePhoto: null };
  const photo = typeof u.profilePhoto === 'string' && /^https:\/\//i.test(u.profilePhoto) ? u.profilePhoto : null;
  return { firstName: (u.firstName || 'A Humrah member').trim().slice(0, 40), profilePhoto: photo };
}

/** Lifetime state of the link itself (not of the group). */
function linkState(inv, now = Date.now()) {
  if (inv.revokedAt) return 'INVITE_REVOKED';
  if (new Date(inv.expiresAt).getTime() <= now) return 'INVITE_EXPIRED';
  if (inv.maxUses != null && inv.useCount >= inv.maxUses) return 'INVITE_EXHAUSTED';
  return null;
}

async function findByToken(token) {
  if (!isWellFormed(token)) return null;
  return GroupInvitation.findOne({ tokenHash: hashToken(token) }).lean();
}

/** True when either user has blocked the other. */
async function blockedBetween(user, otherIds) {
  const ids = [...new Set((otherIds || []).map(String))].filter((id) => !sameId(id, user._id));
  if (ids.length === 0) return false;
  if ((user.blockedUsers || []).some((b) => ids.includes(String(b)))) return true;
  return !!(await User.exists({ _id: { $in: ids }, blockedUsers: user._id }));
}

/**
 * Loads link + group + inviter and decides whether the link can still be used.
 * @returns {{ inv, adapter, group, inviter, code }} — `code` set when unusable.
 */
async function loadContext(token) {
  const inv = await findByToken(token);
  if (!inv) return { code: 'INVITE_INVALID' };
  const adapter = adapterFor(inv.type);
  if (!adapter) return { inv, code: 'INVITE_INVALID' };
  const stateCode = linkState(inv);
  if (stateCode) return { inv, adapter, code: stateCode };
  const group = await adapter.load(inv.targetId);
  if (!group) return { inv, adapter, code: 'GROUP_DELETED' };
  const inviter = await User.findById(inv.createdBy).select('firstName profilePhoto status blockedUsers').lean();
  // A link stops working when its creator can no longer invite: account gone or
  // suspended, or no longer a member of the group.
  if (!inviter || inviter.status !== 'ACTIVE' || !(await adapter.isMember(inviter._id, group))) {
    return { inv, adapter, group, inviter, code: 'INVITE_REVOKED' };
  }
  return { inv, adapter, group, inviter, code: null };
}

// ── CREATE ────────────────────────────────────────────────────────────────────
async function createInvite(user, input = {}) {
  const type = typeof input.type === 'string' ? input.type.trim().toUpperCase() : '';
  const adapter = adapterFor(type);
  if (!adapter) return fail('INVALID_TYPE');
  if (!user || user.status !== 'ACTIVE') return fail('ACCOUNT_NOT_ELIGIBLE');

  let maxUses = null;
  if (input.maxUses !== undefined && input.maxUses !== null && input.maxUses !== '') {
    const n = Number(input.maxUses);
    if (!Number.isInteger(n) || n < 1 || n > MAX_USES_LIMIT) return fail('INVALID_REQUEST');
    maxUses = n;
  }

  const group = await adapter.load(input.targetId);
  if (!group) return fail('GROUP_DELETED');
  const allowed = await adapter.canInvite(user._id, group);
  if (!allowed.ok) return fail(allowed.code);

  const expiresAt = adapter.expiryCap(group);
  if (expiresAt.getTime() - Date.now() < MIN_REMAINING_MS) return fail('GROUP_ENDED');

  const token = newToken();
  await GroupInvitation.create({
    tokenHash: hashToken(token),
    type: adapter.type,
    targetId: group._id,
    createdBy: user._id,
    expiresAt,
    maxUses,
    purgeAt: new Date(expiresAt.getTime() + GroupInvitation.PURGE_AFTER_DAYS * DAY),
  });
  console.log(`[INVITES] created type=${adapter.type} by=${user._id} expiresAt=${expiresAt.toISOString()} maxUses=${maxUses ?? '-'}`);

  return {
    status: 201,
    body: {
      success: true,
      invite: {
        token,
        url: linkFor(token),
        imageUrl: imageFor(token),
        type: adapter.type,
        expiresAt: expiresAt.toISOString(),
        maxUses,
      },
      group: await adapter.preview(group, { detailed: true }),
      inviter: inviterPublic(user),
    },
  };
}

// ── PREVIEW ───────────────────────────────────────────────────────────────────
/**
 * What a link shows. `viewer` (a signed-in user) adds membership; without one the
 * result is the public preview used by the landing page and logged-out apps.
 *
 * state: VALID | FULL | ENDED                  (group details included)
 *        INVITE_INVALID | INVITE_EXPIRED | INVITE_REVOKED | INVITE_EXHAUSTED |
 *        GROUP_DELETED | BLOCKED              (no group details)
 */
async function getPreview(token, viewer = null) {
  const ctx = await loadContext(token);
  if (ctx.code) {
    const base = { success: false, state: ctx.code, code: ctx.code, message: MESSAGES[ctx.code] };
    if (ctx.adapter && ctx.code !== 'INVITE_INVALID') base.type = ctx.adapter.type;
    // A member following an old link can still be sent to their chat.
    if (viewer && ctx.group && ctx.adapter && await ctx.adapter.isMember(viewer._id, ctx.group)) {
      base.viewer = { isMember: true, navigation: await ctx.adapter.navigation(ctx.group, viewer._id) };
    }
    return { status: STATUS[ctx.code] || 404, body: base };
  }
  const { inv, adapter, group, inviter } = ctx;

  let viewerInfo;
  if (viewer) {
    const isMember = await adapter.isMember(viewer._id, group);
    if (isMember) {
      viewerInfo = { isMember: true, navigation: await adapter.navigation(group, viewer._id) };
    } else {
      const others = [inviter._id, ...(await adapter.counterpartIds(group))];
      if (await blockedBetween(viewer, others)) {
        return { status: 403, body: { success: false, state: 'BLOCKED', code: 'BLOCKED', message: MESSAGES.BLOCKED, type: adapter.type } };
      }
      viewerInfo = { isMember: false };
    }
  }

  const groupState = adapter.state(group);
  return {
    status: 200,
    body: {
      success: true,
      state: groupState === 'OPEN' ? 'VALID' : groupState,
      type: adapter.type,
      typeLabel: adapter.label,
      group: await adapter.preview(group, { detailed: !!viewer }),
      inviter: inviterPublic(inviter),
      invite: { expiresAt: new Date(inv.expiresAt).toISOString() },
      ...(viewerInfo ? { viewer: viewerInfo } : {}),
    },
  };
}

// ── JOIN ──────────────────────────────────────────────────────────────────────
async function releaseUse(invId) {
  await GroupInvitation.updateOne({ _id: invId, useCount: { $gt: 0 } }, { $inc: { useCount: -1 } });
}

async function joinWithToken(user, token, io) {
  if (!user || user.status !== 'ACTIVE') return fail('ACCOUNT_NOT_ELIGIBLE');
  const ctx = await loadContext(token);
  const { inv, adapter, group, inviter } = ctx;

  // Already a member: open the chat, whatever happened to the link since.
  if (group && adapter && await adapter.isMember(user._id, group)) {
    return {
      status: 200,
      body: { success: true, result: 'ALREADY_MEMBER', type: adapter.type, navigation: await adapter.navigation(group, user._id) },
    };
  }
  if (ctx.code) return fail(ctx.code, adapter ? { type: adapter.type } : {});

  const others = [inviter._id, ...(await adapter.counterpartIds(group))];
  if (await blockedBetween(user, others)) return fail('BLOCKED', { type: adapter.type });

  const groupState = adapter.state(group);
  if (groupState === 'ENDED') return fail('GROUP_ENDED', { type: adapter.type });
  if (groupState === 'FULL') return fail('GROUP_FULL', { type: adapter.type });

  // Reserve one use. One atomic update: the link must still be live and (with a
  // limit) below it, so two people can never both take the last use.
  const now = new Date();
  const reserved = await GroupInvitation.findOneAndUpdate(
    {
      _id: inv._id,
      revokedAt: null,
      expiresAt: { $gt: now },
      $or: [{ maxUses: null }, { $expr: { $lt: ['$useCount', '$maxUses'] } }],
    },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: now } },
    { new: true }
  ).lean();
  if (!reserved) {
    const latest = await GroupInvitation.findById(inv._id).lean();
    return fail((latest && linkState(latest)) || 'INVITE_EXPIRED', { type: adapter.type });
  }

  let outcome;
  try {
    outcome = await adapter.join({ user, group, io });
  } catch (err) {
    await releaseUse(inv._id).catch(() => {});
    throw err;
  }
  if (!outcome.ok || outcome.alreadyMember) await releaseUse(inv._id).catch(() => {});
  if (!outcome.ok) return fail(outcome.code, { type: adapter.type });

  const fresh = (await adapter.load(group._id)) || group;
  console.log(`[INVITES] ${outcome.alreadyMember ? 'already-member' : 'joined'} type=${adapter.type} user=${user._id}`);
  return {
    status: 200,
    body: {
      success: true,
      result: outcome.alreadyMember ? 'ALREADY_MEMBER' : 'JOINED',
      type: adapter.type,
      navigation: await adapter.navigation(fresh, user._id),
    },
  };
}

// ── REVOKE ────────────────────────────────────────────────────────────────────
async function isGroupHost(adapter, group, userId) {
  if (adapter.type === 'ROOM') {
    const RoomMember = require('../../models/RoomMember');
    return sameId(group.createdBy, userId)
      || !!(await RoomMember.exists({ roomId: group._id, userId, status: 'JOINED', role: 'HOST' }));
  }
  if (adapter.type === 'SPORTS') return sameId(group.creatorId, userId);
  if (adapter.type === 'MOVIE') return sameId(group.adminId, userId) || sameId(group.createdBy, userId);
  return false;
}

async function revokeInvite(user, token) {
  const inv = await findByToken(token);
  if (!inv) return fail('INVITE_INVALID');
  const adapter = adapterFor(inv.type);
  let allowed = sameId(inv.createdBy, user._id);
  if (!allowed && adapter) {
    const group = await adapter.load(inv.targetId);
    allowed = !!group && await isGroupHost(adapter, group, user._id);
  }
  if (!allowed) return fail('NOT_ALLOWED');
  if (!inv.revokedAt) {
    await GroupInvitation.updateOne({ _id: inv._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedBy: user._id } });
    console.log(`[INVITES] revoked type=${inv.type} by=${user._id}`);
  }
  return { status: 200, body: { success: true, revoked: true } };
}

module.exports = {
  createInvite,
  getPreview,
  joinWithToken,
  revokeInvite,
  linkFor,
  imageFor,
  _internal: { loadContext, linkState, inviterPublic, findByToken, STATUS, MESSAGES },
};
