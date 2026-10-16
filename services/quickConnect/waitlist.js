// services/quickConnect/waitlist.js
// -----------------------------------------------------------------------------
// Quick Connect "Notify me" (models/QuickConnectWaitlist.js).
//
//   join     an ELIGIBLE user asks to be told when Quick Connect may have room. One entry per
//            user; first registration sets the place in line; asking again while waiting keeps
//            it, asking again after being notified goes to the back (no queue-jumping).
//            The device token must already be registered to this user, else no push is sent.
//   leave    cancel.
//   notifyTick (sweeper, every QUICK_CONNECT_SWEEP_INTERVAL_MS) tells at most as many people
//            as there are free slots, minus those told in the last CLAIM_WINDOW_MS, oldest
//            first, re-checking eligibility (ineligible entries are removed). Each entry is
//            claimed with a conditional update, so it is notified once even with several
//            backend processes. Nothing is reserved: the message says "may be available" and
//            opening Quick Connect re-checks capacity (no call or microphone starts by itself).
//
// Push delivery: the existing data-only sender (utils/fcmHelper.sendDataFcm). If FCM fails,
// the entry still counts as notified (at most once) and leaves the queue after the claim
// window; the user can tap Notify me again. Queue state never depends on FCM.
// -----------------------------------------------------------------------------
'use strict';

const User = require('../../models/User');
const Waitlist = require('../../models/QuickConnectWaitlist');
const config = require('./config');
const capacity = require('./capacity');
const { evaluateEligibility } = require('./eligibility');
const fcm = () => require('../../utils/fcmHelper');

const CLAIM_WINDOW_MS = 2 * 60 * 1000;
const MAX_NOTIFY_PER_TICK = 20;
const PUSH = Object.freeze({
  type: 'QUICK_CONNECT_AVAILABLE',
  title: 'Quick Connect may be available',
  body: "A spot may have opened up. Tap to check and connect when you're ready."
});

/** The token, if it is one of this user's own registered device tokens; otherwise null. */
async function ownToken(userId, token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (!t || t.length > 4096) return null;
  return (await User.exists({ _id: userId, $or: [{ 'fcmDevices.token': t }, { fcmTokens: t }] })) ? t : null;
}

async function join(userId, { fcmToken = null, auth = null, now = Date.now() } = {}) {
  if (!config.isEnabled()) return { ok: false, code: 'QUICK_CONNECT_DISABLED' };
  const e = await evaluateEligibility(userId, { auth, now });
  if (!e.eligible) return { ok: false, code: e.code };
  const token = await ownToken(userId, fcmToken);
  const expiresAt = new Date(now + config.waitlistTtlMs());
  const keep = await Waitlist.updateOne({ _id: userId, state: 'WAITING' }, { $set: { expiresAt, fcmToken: token } });
  if (keep.matchedCount > 0) return { ok: true, alreadyWaiting: true, push: !!token };
  const fresh = { createdAt: new Date(now), expiresAt, fcmToken: token, state: 'WAITING', notifiedAt: null };
  try {
    await Waitlist.updateOne({ _id: userId }, { $set: fresh }, { upsert: true });
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
    await Waitlist.updateOne({ _id: userId }, { $set: fresh });   // a simultaneous join created it
  }
  return { ok: true, alreadyWaiting: false, push: !!token };
}

async function leave(userId) {
  return { ok: true, removed: (await Waitlist.deleteOne({ _id: userId })).deletedCount > 0 };
}

const isWaiting = async userId => !!(await Waitlist.exists({ _id: userId, state: 'WAITING' }));

/** A user who got into a search no longer needs to be told. */
async function removeOnSearch(userId) {
  try { await Waitlist.deleteOne({ _id: userId }); } catch (err) {
    console.error('[quick-connect] waitlist cleanup failed:', err && err.name);
  }
}

/** One pass of the queue. Returns counters (no user data). */
async function notifyTick({ now = Date.now() } = {}) {
  const c = { waitlistNotified: 0, waitlistRemoved: 0, waitlistExpired: 0, waitlistPushFailed: 0 };
  c.waitlistExpired = (await Waitlist.deleteMany({ $or: [
    { expiresAt: { $lte: new Date(now) } },
    { state: 'NOTIFIED', notifiedAt: { $lte: new Date(now - CLAIM_WINDOW_MS) } }
  ] })).deletedCount;
  if (!config.isEnabled()) return c;

  const told = await Waitlist.countDocuments({ state: 'NOTIFIED' });
  const free = Math.min(MAX_NOTIFY_PER_TICK, config.maxActiveCalls() - (await capacity.activeCount()) - told);
  if (free <= 0) return c;

  const rows = await Waitlist.find({ state: 'WAITING', expiresAt: { $gt: new Date(now) }, fcmToken: { $ne: null } })
    .sort({ createdAt: 1, _id: 1 }).limit(free * 3).lean();
  for (const row of rows) {
    if (c.waitlistNotified >= free) break;
    const e = await evaluateEligibility(row._id, { now });
    if (!e.eligible) {                                   // restricted, unverified, in a call, …
      c.waitlistRemoved += (await Waitlist.deleteOne({ _id: row._id, state: 'WAITING' })).deletedCount;
      continue;
    }
    const claimed = await Waitlist.findOneAndUpdate(
      { _id: row._id, state: 'WAITING' },
      { $set: { state: 'NOTIFIED', notifiedAt: new Date(now) } },
      { new: true }
    ).lean();
    if (!claimed) continue;                              // cancelled, or another process took it
    c.waitlistNotified++;
    const r = await fcm().sendDataFcm(row._id, [claimed.fcmToken],
      { type: PUSH.type, recipientUserId: String(row._id), title: PUSH.title, body: PUSH.body }, { quietLog: true });
    if (!r || !r.delivered) c.waitlistPushFailed++;
  }
  return c;
}

module.exports = { join, leave, isWaiting, removeOnSearch, notifyTick, CLAIM_WINDOW_MS, MAX_NOTIFY_PER_TICK, PUSH };
