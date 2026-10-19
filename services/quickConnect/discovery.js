// services/quickConnect/discovery.js
// -----------------------------------------------------------------------------
// Quick Connect Smart Discovery: when a search has run for QUICK_CONNECT_SMART_DISCOVERY_DELAY_MS
// (default 30 s) without a match, invite a few OTHER people who opted in and share an interest
// with the searcher. The search itself keeps running unchanged.
//
// Who can be invited (all checked on the server, again at send time and again on accept):
//   - opted in (QuickConnectPreference.smartDiscovery) from a phone whose token is still
//     registered to them; invitations go only to that phone;
//   - fully eligible right now (evaluateEligibility: switch, account, 18+, verification,
//     consent, not busy) and not searching themselves (searchers are matched normally);
//   - not blocked either way, not under a skip/report exclusion with the searcher;
//   - at least one shared interest (the existing interest ranking orders them);
//   - not invited within QUICK_CONNECT_INVITE_COOLDOWN_MS, and at most MAX_PER_RECIPIENT_PER_DAY
//     invitations in 24 h; one open invitation per person at a time (unique index).
// No location is used: Quick Connect is global.
//
// Limits on the searcher: one round per search (search.discoveryAt is claimed with a conditional
// write), at most QUICK_CONNECT_INVITES_PER_SEARCH invitations per round, at most
// MAX_ROUNDS_PER_INVITER_PER_HOUR rounds per hour. At most MAX_INVITES_PER_TICK per sweep.
//
// An invitation never starts a call. Accepting it (socket qc_invite_accept, recipient only)
// re-checks everything and, through the normal pairing code (matching.pairUp), creates an
// ordinary PROPOSED match that BOTH people must still accept within 15 s. Declining needs
// nothing else. When the searcher's search ends (cancel, timeout, a normal match, consent
// withdrawn, switched off) open invitations are cancelled and the recipient's notification
// is withdrawn; anything missed is cancelled by the next sweep, and accepting a stale one
// always fails safely.
//
// Delivery: an in-app event to the recipient's /quick-connect sockets when connected, else one
// data-only FCM message (utils/fcmHelper) carrying only ids, the expiry and generic text —
// never the searcher's name, photo, id or any other personal data. FCM failures are not
// retried (no loops); the invitation simply expires.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const User = require('../../models/User');
const Invite = require('../../models/QuickConnectInvite');
const Preference = require('../../models/QuickConnectPreference');
const QuickConnectSearch = require('../../models/QuickConnectSearch');
const config = require('./config');
const notify = require('./notify');
const matching = require('./matching');
const { evaluateEligibility } = require('./eligibility');
const fcm = () => require('../../utils/fcmHelper');

const MAX_PER_RECIPIENT_PER_DAY = 6;
const MAX_ROUNDS_PER_INVITER_PER_HOUR = 4;
const MAX_INVITES_PER_TICK = 30;
const MAX_SEARCHES_PER_TICK = 10;
const CANDIDATE_POOL = 300;
const MAX_SHARED_SHOWN = 3;
const INTEREST_SELECT = 'questionnaire.interests questionnaire.hobbies questionnaire.conversationInterests questionnaire.humrahRoomInterests';
const PUSH = Object.freeze({
  type: 'QUICK_CONNECT_INVITE',
  cancelType: 'QUICK_CONNECT_INVITE_CANCELLED',
  title: 'Someone wants to talk now',
  body: 'A Humrah member who shares your interests is looking for a quick voice chat. Tap to see. You decide.'
});

const isId = v => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.isValidObjectId(v);
const fail = code => ({ ok: false, code });

/** The token, if it is currently registered to this user; otherwise null. */
async function ownToken(userId, token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (!t || t.length > 4096) return null;
  return (await User.exists({ _id: userId, $or: [{ 'fcmDevices.token': t }, { fcmTokens: t }] })) ? t : null;
}

// ── preferences ───────────────────────────────────────────────────────────────

/** push = the saved phone token is STILL registered to the user (FCM tokens rotate; the app then re-sends its own). */
async function getPreference(userId) {
  const p = await Preference.findById(userId).lean();
  const optedIn = !!(p && p.smartDiscovery);
  return { optedIn, push: optedIn && !!(await ownToken(userId, p.fcmToken)) };
}

/**
 * Turns the opt-in on (eligible users only, with this phone's own registered token) or off
 * (always allowed). Turning it off also cancels any open invitation to the user.
 */
async function setPreference(userId, { smartDiscovery, fcmToken = null, auth = null, now = Date.now() } = {}) {
  if (smartDiscovery !== true) {
    await Preference.updateOne({ _id: userId }, { $set: { smartDiscovery: false, fcmToken: null, updatedAt: new Date(now) } }, { upsert: true });
    await cancelForRecipient(userId, { notifyRecipient: true });
    return { ok: true, optedIn: false, push: false };
  }
  if (!config.isEnabled()) return fail('QUICK_CONNECT_DISABLED');
  const e = await evaluateEligibility(userId, { auth, checkBusy: false, now });
  if (!e.eligible) return fail(e.code);
  const token = await ownToken(userId, fcmToken);
  await Preference.updateOne({ _id: userId }, { $set: { smartDiscovery: true, fcmToken: token, updatedAt: new Date(now) } }, { upsert: true });
  return { ok: true, optedIn: true, push: !!token };
}

// ── delivery ──────────────────────────────────────────────────────────────────

async function deliverInvite(invite, token) {
  const payload = { inviteId: String(invite._id), expiresAt: new Date(invite.expiresAt).toISOString(), sharedInterests: invite.sharedInterests };
  if (await notify.socketCount(invite.recipientId) > 0) {
    notify.toUser(invite.recipientId, 'qc_invite', payload);
    return 'socket';
  }
  const r = await fcm().sendDataFcm(invite.recipientId, [token], {
    type: PUSH.type, recipientUserId: String(invite.recipientId), inviteId: payload.inviteId,
    expiresAt: payload.expiresAt, title: PUSH.title, body: PUSH.body
  }, { quietLog: true });
  return r && r.delivered ? 'push' : 'none';
}

/** Tells the recipient an invitation is gone, through the same path it arrived. Best effort, once. */
async function withdrawDelivered(invite) {
  try {
    notify.toUser(invite.recipientId, 'qc_invite_cancelled', { inviteId: String(invite._id) });
    if (invite.delivery !== 'push') return;
    const pref = await Preference.findById(invite.recipientId).select('fcmToken').lean();
    if (!pref || !pref.fcmToken) return;
    await fcm().sendDataFcm(invite.recipientId, [pref.fcmToken],
      { type: PUSH.cancelType, recipientUserId: String(invite.recipientId), inviteId: String(invite._id) }, { quietLog: true });
  } catch (err) {
    console.error('[quick-connect] invite withdrawal failed:', err && err.name);
  }
}

/** Cancels open invitations matching `filter` (conditional, one by one) and withdraws their notifications. */
async function cancelWhere(filter, { notifyRecipient = true, limit = 200 } = {}) {
  const rows = await Invite.find({ $and: [{ status: 'PENDING' }, filter] }).limit(limit).lean();
  let n = 0;
  for (const row of rows) {
    const r = await Invite.updateOne({ _id: row._id, status: 'PENDING' }, { $set: { status: 'CANCELLED', respondedAt: new Date() } });
    if (r.modifiedCount === 0) continue;
    n++;
    if (notifyRecipient) await withdrawDelivered(row);
  }
  return n;
}

const cancelForInviter = (inviterId, opts) => cancelWhere({ inviterId }, opts);
const cancelForRecipient = (recipientId, opts) => cancelWhere({ recipientId }, opts);

// ── sending ───────────────────────────────────────────────────────────────────

/** Users who must not be invited for `inviterId` right now (blocks, exclusions, cooldowns, limits, searchers). */
async function excludedFor(inviterId, now) {
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const [mine, blockers, skipped, searching, cooling, capped] = await Promise.all([
    User.findById(inviterId).select('blockedUsers').lean(),
    User.find({ blockedUsers: inviterId }).select('_id').limit(5000).lean(),
    matching._internal.excludedPartners(inviterId, now),
    QuickConnectSearch.find({}).select('_id').limit(5000).lean(),
    Invite.distinct('recipientId', { createdAt: { $gt: new Date(now - config.inviteCooldownMs()) } }),
    Invite.aggregate([
      { $match: { createdAt: { $gt: dayAgo } } },
      { $group: { _id: '$recipientId', n: { $sum: 1 } } },
      { $match: { n: { $gte: MAX_PER_RECIPIENT_PER_DAY } } }
    ])
  ]);
  return [
    inviterId, ...((mine && mine.blockedUsers) || []), ...blockers.map(b => b._id), ...skipped,
    ...searching.map(s => s._id), ...cooling, ...capped.map(c => c._id)
  ];
}

/** Sends one invitation round for the search row `search` (already claimed). Returns how many were sent. */
async function inviteFor(search, { now, budget }) {
  const inviterId = search._id;
  const e = await evaluateEligibility(inviterId, { now });
  if (!e.eligible) return 0;
  const rounds = await Invite.distinct('searchStartedAt', { inviterId, createdAt: { $gt: new Date(now - 60 * 60 * 1000) } });
  if (rounds.length >= MAX_ROUNDS_PER_INVITER_PER_HOUR) return 0;
  if (!search.interests || search.interests.length === 0) return 0;

  const exclude = await excludedFor(inviterId, now);
  const prefs = await Preference.find({ smartDiscovery: true, fcmToken: { $ne: null }, _id: { $nin: exclude } })
    .select('_id fcmToken').limit(CANDIDATE_POOL).lean();
  if (prefs.length === 0) return 0;
  const users = await User.find({ _id: { $in: prefs.map(p => p._id) } }).select(INTEREST_SELECT).lean();
  const tokenOf = new Map(prefs.map(p => [String(p._id), p.fcmToken]));
  const ranked = users
    .map(u => ({ id: u._id, shared: matching.normalizeInterests(u.questionnaire).filter(i => search.interests.includes(i)) }))
    .filter(c => c.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length);

  const want = Math.min(config.invitesPerSearch(), budget);
  let sent = 0;
  for (const cand of ranked) {
    if (sent >= want) break;
    if (!(await QuickConnectSearch.exists({ _id: inviterId, startedAt: search.startedAt, status: 'SEARCHING' }))) break;   // matched or gone meanwhile
    const ce = await evaluateEligibility(cand.id, { now });
    if (!ce.eligible) continue;
    if (await matching.pairExcluded(inviterId, cand.id, now)) continue;
    const token = await ownToken(cand.id, tokenOf.get(String(cand.id)));
    if (!token) continue;
    let invite;
    try {
      invite = await Invite.create({
        inviterId, recipientId: cand.id, searchStartedAt: search.startedAt,
        sharedInterests: cand.shared.slice(0, MAX_SHARED_SHOWN),
        createdAt: new Date(now), expiresAt: new Date(now + config.inviteTtlMs())
      });
    } catch (err) {
      if (err && err.code === 11000) continue;          // they already have an open invitation
      throw err;
    }
    const delivery = await deliverInvite(invite, token);
    await Invite.updateOne({ _id: invite._id }, { $set: { delivery } });
    sent++;
  }
  if (sent > 0) notify.toUser(inviterId, 'qc_discovery', { invited: sent });
  return sent;
}

/**
 * One sweep pass: expires and cancels stale invitations, then (when enabled) sends rounds for
 * searches that have waited long enough. Returns counters (no user data).
 */
async function tick({ now = Date.now() } = {}) {
  const c = { invitesSent: 0, invitesExpired: 0, invitesCancelled: 0 };
  c.invitesExpired = (await Invite.updateMany(
    { status: 'PENDING', expiresAt: { $lte: new Date(now) } },
    { $set: { status: 'EXPIRED', respondedAt: new Date(now) } }
  )).modifiedCount;
  // A crash between ACCEPTING and the end of acceptInvite leaves a row in ACCEPTING: close it.
  await Invite.updateMany({ status: 'ACCEPTING', expiresAt: { $lte: new Date(now - 60 * 1000) } }, { $set: { status: 'CANCELLED' } });

  if (!config.smartDiscoveryEnabled()) {
    c.invitesCancelled = await cancelWhere({});
    return c;
  }
  // Open invitations whose search is over (cancelled, timed out, matched, disconnected).
  const open = await Invite.find({ status: 'PENDING' }).select('inviterId searchStartedAt').limit(500).lean();
  const seen = new Set();
  for (const row of open) {
    const key = `${row.inviterId}|${new Date(row.searchStartedAt).getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await QuickConnectSearch.exists({ _id: row.inviterId, startedAt: row.searchStartedAt }))) {
      c.invitesCancelled += await cancelWhere({ inviterId: row.inviterId, searchStartedAt: row.searchStartedAt });
    }
  }

  const cut = new Date(now - config.smartDiscoveryDelayMs());
  const due = await QuickConnectSearch.find({ status: 'SEARCHING', discoveryAt: null, startedAt: { $lte: cut } })
    .sort({ startedAt: 1 }).limit(MAX_SEARCHES_PER_TICK).lean();
  for (const row of due) {
    if (c.invitesSent >= MAX_INVITES_PER_TICK) break;
    const claimed = await QuickConnectSearch.findOneAndUpdate(
      { _id: row._id, startedAt: row.startedAt, status: 'SEARCHING', discoveryAt: null },
      { $set: { discoveryAt: new Date(now) } }, { new: true }
    ).lean();
    if (!claimed) continue;
    c.invitesSent += await inviteFor(claimed, { now, budget: MAX_INVITES_PER_TICK - c.invitesSent });
  }
  return c;
}

// ── answering ─────────────────────────────────────────────────────────────────

const STATUS_CODE = { ACCEPTING: 'INVITE_ANSWERED', ACCEPTED: 'INVITE_ANSWERED', DECLINED: 'INVITE_ANSWERED', EXPIRED: 'INVITE_EXPIRED', CANCELLED: 'INVITE_EXPIRED' };

/** The recipient's view of their own invitation (no data about the searcher). */
async function getInvite(userId, inviteId, { now = Date.now() } = {}) {
  if (!isId(inviteId)) return fail('INVALID_REQUEST');
  const inv = await Invite.findOne({ _id: inviteId, recipientId: userId }).lean();
  if (!inv) return fail('INVITE_NOT_FOUND');
  let status = inv.status;
  if (status === 'PENDING' && new Date(inv.expiresAt).getTime() <= now) status = 'EXPIRED';
  if (status === 'PENDING' && !(await QuickConnectSearch.exists({ _id: inv.inviterId, startedAt: inv.searchStartedAt }))) status = 'CANCELLED';
  return {
    ok: true,
    invite: {
      inviteId: String(inv._id), status: status.toLowerCase(),
      expiresAt: new Date(inv.expiresAt).toISOString(), sharedInterests: inv.sharedInterests || []
    }
  };
}

/** Recipient declines. Idempotent; works while switched off. */
async function declineInvite(userId, inviteId, { now = Date.now() } = {}) {
  if (!isId(inviteId)) return fail('INVALID_REQUEST');
  const r = await Invite.updateOne({ _id: inviteId, recipientId: userId, status: 'PENDING' }, { $set: { status: 'DECLINED', respondedAt: new Date(now) } });
  if (r.modifiedCount > 0) return { ok: true, alreadyAnswered: false };
  return (await Invite.exists({ _id: inviteId, recipientId: userId })) ? { ok: true, alreadyAnswered: true } : fail('INVITE_NOT_FOUND');
}

/**
 * Recipient accepts (socket only, so the proposal can reach them). Re-checks everything and
 * creates an ordinary PROPOSED match through matching.pairUp; both must still accept it.
 * Resolves { ok: true, state: 'proposed', sessionId } or { ok: false, code }.
 */
async function acceptInvite(userId, inviteId, { auth = null, now = Date.now() } = {}) {
  if (!isId(inviteId)) return fail('INVALID_REQUEST');
  if (!config.smartDiscoveryEnabled()) return fail('QUICK_CONNECT_DISABLED');
  const inv = await Invite.findOne({ _id: inviteId, recipientId: userId }).lean();
  if (!inv) return fail('INVITE_NOT_FOUND');
  if (inv.status !== 'PENDING') return fail(STATUS_CODE[inv.status] || 'INVITE_EXPIRED');
  if (new Date(inv.expiresAt).getTime() <= now) {
    await Invite.updateOne({ _id: inv._id, status: 'PENDING' }, { $set: { status: 'EXPIRED', respondedAt: new Date(now) } });
    return fail('INVITE_EXPIRED');
  }
  const claimed = await Invite.findOneAndUpdate(
    { _id: inv._id, status: 'PENDING', expiresAt: { $gt: new Date(now) } },
    { $set: { status: 'ACCEPTING', respondedAt: new Date(now) } }, { new: true }
  ).lean();
  if (!claimed) return fail('INVITE_EXPIRED');
  const close = async (status) => Invite.updateOne({ _id: inv._id, status: 'ACCEPTING' }, { $set: { status } });

  const inviterRow = await QuickConnectSearch.findOne({ _id: inv.inviterId, startedAt: inv.searchStartedAt, status: 'SEARCHING' }).lean();
  if (!inviterRow) { await close('CANCELLED'); return fail('INVITE_EXPIRED'); }

  const e = await evaluateEligibility(userId, { auth, now });
  if (!e.eligible) { await close('CANCELLED'); return fail(e.code); }

  // The recipient joins matching only for this pairing: a short-lived search row of their own.
  let createdRow = false;
  let mine = await QuickConnectSearch.findOne({ _id: userId, status: 'SEARCHING' }).lean();
  if (!mine) {
    const user = await User.findById(userId).select(INTEREST_SELECT).lean();
    try {
      mine = (await QuickConnectSearch.create({
        _id: userId, interests: matching.normalizeInterests(user && user.questionnaire),
        startedAt: new Date(now), broadenAt: new Date(now), expiresAt: new Date(now + 60 * 1000),
        discoveryAt: new Date(now)                      // never sends invitations of its own
      })).toObject();
      createdRow = true;
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      mine = await QuickConnectSearch.findOne({ _id: userId, status: 'SEARCHING' }).lean();
    }
  }
  if (!mine) { await close('CANCELLED'); return fail('INVITE_UNAVAILABLE'); }

  const result = await matching._internal.pairUp(inviterRow, mine, now);
  if (result && typeof result === 'object' && result._id) {
    await Invite.updateOne({ _id: inv._id, status: 'ACCEPTING' }, { $set: { status: 'ACCEPTED', sessionId: result._id } });
    return { ok: true, state: 'proposed', sessionId: String(result._id) };
  }
  await close('CANCELLED');
  if (createdRow) await QuickConnectSearch.deleteOne({ _id: userId, status: 'SEARCHING', discoveryAt: new Date(now) });
  return fail('INVITE_UNAVAILABLE');
}

module.exports = {
  getPreference, setPreference, tick, getInvite, declineInvite, acceptInvite,
  cancelForInviter, cancelForRecipient, PUSH,
  MAX_PER_RECIPIENT_PER_DAY, MAX_ROUNDS_PER_INVITER_PER_HOUR, MAX_INVITES_PER_TICK,
  _internal: { inviteFor, excludedFor, ownToken, deliverInvite, withdrawDelivered }
};
