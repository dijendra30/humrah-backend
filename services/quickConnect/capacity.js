// services/quickConnect/capacity.js
// -----------------------------------------------------------------------------
// Quick Connect capacity: at most QUICK_CONNECT_MAX_ACTIVE_CALLS open sessions at once
// (PROPOSED, ACCEPTED, CONNECTING, CONNECTED — a proposal is about to become a relayed call).
//
// Each open session holds one numbered slot (models/QuickConnectCapacitySlot.js):
//   claim    sessions.createSession, after both user holds — an atomic insert of the first
//            free slot number below the limit; full → the session is not created.
//   release  every end path (sessions.endSession / sweepStaleSessions).
//   reconcile the sweeper removes slots whose session is over or was never written (crash),
//            so a restart or a lost process can never leave capacity stuck.
// Established calls are never ended because of capacity: lowering the limit only stops new
// sessions until enough calls have finished.
// -----------------------------------------------------------------------------
'use strict';

const QuickConnectSession = require('../../models/QuickConnectSession');
const Slot = require('../../models/QuickConnectCapacitySlot');
const config = require('./config');

const IN_FLIGHT_GRACE_MS = 15 * 1000;   // the session row is written right after the claim

const activeCount = () => Slot.countDocuments({});
async function isFull() { return (await activeCount()) >= config.maxActiveCalls(); }

/** Claims one slot for sessionId. true = claimed, false = Quick Connect is full. */
async function claim(sessionId, { now = Date.now() } = {}) {
  const max = config.maxActiveCalls();
  if ((await activeCount()) >= max) return false;           // also covers a limit lowered meanwhile
  const taken = new Set((await Slot.find({ _id: { $lt: max } }).select('_id').lean()).map(s => s._id));
  for (let k = 0; k < max; k++) {
    if (taken.has(k)) continue;
    try {
      await Slot.create({ _id: k, sessionId, claimedAt: new Date(now) });
      return true;
    } catch (err) {
      if (err && err.code === 11000) continue;              // someone took it first: next number
      throw err;
    }
  }
  return false;
}

/** Releases the slot of a session (no-op when it has none). */
async function release(sessionId) {
  if (!sessionId) return 0;
  return (await Slot.deleteMany({ sessionId })).deletedCount;
}

/** Removes slots whose session is over, or missing past the in-flight grace. Returns how many. */
async function reconcile({ now = Date.now() } = {}) {
  const slots = await Slot.find({}).select('_id sessionId claimedAt').limit(1000).lean();
  if (!slots.length) return 0;
  const open = await QuickConnectSession.find({ _id: { $in: slots.map(s => s.sessionId) }, status: { $in: QuickConnectSession.ACTIVE_STATUSES } })
    .select('_id').lean();
  const live = new Set(open.map(s => String(s._id)));
  let removed = 0;
  for (const s of slots) {
    if (live.has(String(s.sessionId))) continue;
    if (now - new Date(s.claimedAt).getTime() < IN_FLIGHT_GRACE_MS) {
      if (!(await QuickConnectSession.exists({ _id: s.sessionId }))) continue;   // still being created
    }
    removed += (await Slot.deleteOne({ _id: s._id, sessionId: s.sessionId })).deletedCount;
  }
  return removed;
}

module.exports = { claim, release, reconcile, activeCount, isFull, IN_FLIGHT_GRACE_MS };
