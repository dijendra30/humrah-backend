// services/sportsSessionService.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 2A. Sports Sessions: every Sports plan becomes one
// session whose members are the plan's players. Messages → Sessions lists them;
// Phase 3's group chat will belong to them.
//
// SOURCE OF TRUTH. The plan stays authoritative for who is in it
// (SportsPlan.playersJoined, changed only by Phase 1A's single-document atomic
// updates) and for when it is. The session never decides membership; it follows.
//
// KEEPING IN STEP, WITHOUT TRANSACTIONS. Nothing in this codebase uses multi-
// document transactions (see models/User.js), so the plan write and the session
// write cannot be one atomic unit. Instead:
//   1. The plan write happens first, exactly as in Phase 1A — it decides success.
//   2. The session follows immediately, with idempotent writes: upserts keyed on
//      a unique index, and status changes guarded on the current status. Running
//      any of them twice, or two at once, gives the same result.
//   3. Every read of a session reconciles it against its plan (reconcile()),
//      repairing anything step 2 missed — a crash or DB error between the two
//      writes, a plan created before Phase 2A, a lost upsert race.
// A failure in step 2 is logged as [SPORTS_SESSION_SYNC_FAILED] and does not fail
// the user's join or leave, which already happened; step 3 heals it.
//
// PHASE 4 (notifications) hooks in at onPlanCreated / onPlayerJoined /
// onPlayerLeft / onPlanCancelled: each is called exactly once per real change.
// -----------------------------------------------------------------------------
'use strict';

const mongoose            = require('mongoose');
const SportsPlan          = require('../models/SportsPlan');
const SportsSession       = require('../models/SportsSession');
const SportsSessionMember = require('../models/SportsSessionMember');

const { ObjectId } = mongoose.Types;

// Required lazily: the plan service calls into this one for every change.
const planService = () => require('./sportsPlanService');

// A session stays in Messages → Sessions while its chat window is open
// (the plan's chatExpiresAt, end + 3 h) and for 30 minutes after it closes or
// the plan is cancelled — the rule Movie and Gaming sessions already follow.
const LIST_GRACE_MS = 30 * 60 * 1000;
const MAX_SESSIONS  = 50;

const fail = (status, code, message, extra = {}) => ({ success: false, status, code, message, ...extra });
const notFound = () => fail(404, 'SESSION_NOT_FOUND', 'This session does not exist or is no longer available.');
const isValidId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const same = (a, b) => String(a) === String(b);
const includesId = (list, id) => (list || []).some(x => same(x, id));
/** A duplicate-key error — including a bulk write whose every failure is one. */
const isDuplicateKey = err => !!err && (
  err.code === 11000 ||
  (Array.isArray(err.writeErrors) && err.writeErrors.length > 0 && err.writeErrors.every(e => e.code === 11000))
);

/**
 * upcoming → live → ended, from the plan's own times; or cancelled. Never stored,
 * so nothing has to flip it on the hour — the same way Phase 1A derives 'expired'.
 */
function sessionPhase(plan, session, now = Date.now()) {
  if ((session && session.status === 'cancelled') || plan.cardStatus === 'cancelled') return 'cancelled';
  if (now < new Date(plan.startTime).getTime()) return 'upcoming';
  if (now < new Date(plan.endTime).getTime()) return 'live';
  return 'ended';
}

// ── Keeping the session in step with the plan ─────────────────────────────────

/**
 * The plan's session, created if it does not exist. Safe to call any number of
 * times, concurrently: the unique sportsPlanId turns every call after the first
 * into a read.
 */
async function ensureSession(plan) {
  const filter = { sportsPlanId: plan._id };
  const cancelled = plan.cardStatus === 'cancelled';
  try {
    return await SportsSession.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          sportsPlanId: plan._id,
          creatorId:    plan.creatorId,
          status:       cancelled ? 'cancelled' : 'active',
          cancelledAt:  cancelled ? (plan.cancelledAt || new Date()) : null,
        },
      },
      { upsert: true, new: true },
    ).lean();
  } catch (err) {
    // Two first calls raced and the other one inserted. Its document is the answer.
    if (isDuplicateKey(err)) return SportsSession.findOne(filter).lean();
    throw err;
  }
}

/** Makes [userId] a JOINED member — first join or rejoin. Idempotent. */
async function markJoined(session, plan, userId, now = new Date()) {
  const role = same(userId, plan.creatorId) ? 'HOST' : 'PARTICIPANT';
  try {
    await SportsSessionMember.updateOne(
      { sessionId: session._id, userId },
      {
        $set:         { status: 'JOINED', role, leftAt: null },
        $setOnInsert: { sportsPlanId: plan._id, joinedAt: now },
      },
      { upsert: true },
    );
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;   // a concurrent upsert inserted the row
  }
}

/**
 * Brings the session's members and status into line with its plan. Writes only
 * what differs, so an already consistent session costs one read.
 *
 * @returns the number of repairs made (0 when everything already agreed).
 */
async function reconcile(plan, session, now = new Date()) {
  const members = await SportsSessionMember.find({ sessionId: session._id }).select('userId status').lean();
  const byUser  = new Map(members.map(m => [String(m.userId), m]));
  const inPlan  = new Set((plan.playersJoined || []).map(String));
  const ops = [];

  for (const uid of inPlan) {
    const m = byUser.get(uid);
    if (!m || m.status !== 'JOINED') {
      ops.push({
        updateOne: {
          filter: { sessionId: session._id, userId: new ObjectId(uid) },
          update: {
            $set:         { status: 'JOINED', role: same(uid, plan.creatorId) ? 'HOST' : 'PARTICIPANT', leftAt: null },
            $setOnInsert: { sportsPlanId: plan._id, joinedAt: now },
          },
          upsert: true,
        },
      });
    }
  }
  for (const m of members) {
    if (m.status === 'JOINED' && !inPlan.has(String(m.userId))) {
      const removed = includesId(plan.kickedPlayers, m.userId);
      ops.push({
        updateOne: {
          filter: { _id: m._id, status: 'JOINED' },
          update: { $set: { status: removed ? 'REMOVED' : 'LEFT', leftAt: now } },
        },
      });
    }
  }

  let repairs = ops.length;
  if (ops.length) {
    try {
      await SportsSessionMember.bulkWrite(ops, { ordered: false });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
  if (plan.cardStatus === 'cancelled' && session.status !== 'cancelled') {
    await SportsSession.updateOne(
      { _id: session._id, status: 'active' },
      { $set: { status: 'cancelled', cancelledAt: plan.cancelledAt || now } },
    );
    session.status = 'cancelled';
    session.cancelledAt = plan.cancelledAt || now;
    repairs += 1;
  }
  if (repairs > 0) {
    console.warn(`[SPORTS_SESSION_RECONCILED] session=${session._id} plan=${plan._id} repairs=${repairs}`);
  }
  return repairs;
}

/**
 * Runs a session write after a plan change that has already succeeded. A failure
 * is logged, not thrown: the user's plan change stands, and the next read of the
 * session reconciles it (see the header).
 */
async function followPlan(label, plan, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[SPORTS_SESSION_SYNC_FAILED] ${label} plan=${plan && plan._id}:`, err && err.message);
    return null;
  }
}

// The four moments a session changes. Each is called once, after the plan's own
// atomic update succeeded. Phase 4 notifications belong here.

/** A plan was created: its session, with the host as the first member. */
function onPlanCreated(plan) {
  return followPlan('create', plan, async () => {
    const session = await ensureSession(plan);
    await markJoined(session, plan, plan.creatorId);
    return session;
  });
}

function onPlayerJoined(plan, userId) {
  return followPlan('join', plan, async () => {
    const session = await ensureSession(plan);
    await markJoined(session, plan, userId);
    return session;
  });
}

function onPlayerLeft(plan, userId) {
  return followPlan('leave', plan, async () => {
    const session = await ensureSession(plan);
    await SportsSessionMember.updateOne(
      { sessionId: session._id, userId, status: 'JOINED' },
      { $set: { status: 'LEFT', leftAt: new Date() } },
    );
    return session;
  });
}

function onPlanCancelled(plan) {
  return followPlan('cancel', plan, async () => {
    const session = await ensureSession(plan);
    const cancelledAt = plan.cancelledAt || new Date();
    await SportsSession.updateOne(
      { _id: session._id, status: 'active' },
      { $set: { status: 'cancelled', cancelledAt } },
    );
    return { ...session, status: 'cancelled', cancelledAt: session.cancelledAt || cancelledAt };
  });
}

/**
 * The session id to show a plan's member (plan responses carry it so the app can
 * open the session). Creates the session for a plan that predates Phase 2A.
 */
function sessionIdForMember(plan) {
  return followPlan('lookup', plan, async () => String((await ensureSession(plan))._id));
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** The one shape a session leaves this service in. [plan] is already formatted. */
function formatSession(session, plan, member, formattedPlan, now = Date.now()) {
  return {
    id:            String(session._id),
    sportsPlanId:  String(plan._id),
    status:        session.status,
    phase:         sessionPhase(plan, session, now),
    role:          member && member.role === 'HOST' ? 'HOST' : 'PARTICIPANT',
    memberCount:   (plan.playersJoined || []).length,
    playerLimit:   plan.playerLimit,
    joinedAt:      member && member.joinedAt ? new Date(member.joinedAt).toISOString() : null,
    lastMessageAt: session.lastMessageAt ? new Date(session.lastMessageAt).toISOString() : null,
    createdAt:     session.createdAt ? new Date(session.createdAt).toISOString() : null,
    cancelledAt:   session.cancelledAt ? new Date(session.cancelledAt).toISOString() : null,
    plan:          formattedPlan,
  };
}

const PHASE_ORDER = { live: 0, upcoming: 1, ended: 2, cancelled: 3 };

/**
 * The caller's Sports sessions for Messages → Sessions: every plan they are in
 * (host or player), found from the plan itself so a missed session write can
 * never hide one, within the list window. A plan whose host is in a block with
 * the caller is left out, as Phase 1A leaves it out of every other read.
 *
 * Four queries whatever the count: plans, blocks, sessions, the caller's rows.
 */
async function listMySessions(user) {
  const uid   = user._id;
  const now   = Date.now();
  const since = new Date(now - LIST_GRACE_MS);
  const svc   = planService();

  let plans = await SportsPlan.find({
    playersJoined: uid,
    $or: [
      { cardStatus: { $ne: 'cancelled' }, chatExpiresAt: { $gt: since } },
      { cardStatus: 'cancelled', cancelledAt: { $gt: since } },
    ],
  }).sort({ startTime: 1 }).limit(MAX_SESSIONS).lean();

  const blocked = new Set((await svc._internal.blockedCounterparts(user)).map(String));
  plans = plans.filter(p => !blocked.has(String(p.creatorId)));
  if (plans.length === 0) return { success: true, status: 200, sessions: [], count: 0 };

  // Sessions for these plans; any that are missing (created before Phase 2A, or
  // a failed write) are created now, in one round trip.
  const planIds = plans.map(p => p._id);
  let sessions = await SportsSession.find({ sportsPlanId: { $in: planIds } }).lean();
  const have = new Set(sessions.map(s => String(s.sportsPlanId)));
  const missing = plans.filter(p => !have.has(String(p._id)));
  if (missing.length) {
    try {
      await SportsSession.bulkWrite(missing.map(p => ({
        updateOne: {
          filter: { sportsPlanId: p._id },
          update: {
            $setOnInsert: {
              sportsPlanId: p._id,
              creatorId:    p.creatorId,
              status:       p.cardStatus === 'cancelled' ? 'cancelled' : 'active',
              cancelledAt:  p.cardStatus === 'cancelled' ? (p.cancelledAt || new Date()) : null,
            },
          },
          upsert: true,
        },
      })), { ordered: false });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    sessions = await SportsSession.find({ sportsPlanId: { $in: planIds } }).lean();
    console.warn(`[SPORTS_SESSION_RECONCILED] created ${missing.length} missing session(s) for user=${uid}`);
  }
  const sessionByPlan = new Map(sessions.map(s => [String(s.sportsPlanId), s]));

  // The caller's own member rows, repaired in one write if any are off.
  const sessionIds = sessions.map(s => s._id);
  const mine = await SportsSessionMember.find({ userId: uid, sessionId: { $in: sessionIds } }).lean();
  const mineBySession = new Map(mine.map(m => [String(m.sessionId), m]));
  const fixes = [];
  for (const p of plans) {
    const s = sessionByPlan.get(String(p._id));
    const m = s && mineBySession.get(String(s._id));
    if (s && (!m || m.status !== 'JOINED')) {
      fixes.push({
        updateOne: {
          filter: { sessionId: s._id, userId: uid },
          update: {
            $set:         { status: 'JOINED', role: same(uid, p.creatorId) ? 'HOST' : 'PARTICIPANT', leftAt: null },
            $setOnInsert: { sportsPlanId: p._id, joinedAt: new Date() },
          },
          upsert: true,
        },
      });
    }
    // Sessions of cancelled plans that missed the cancel write.
    if (s && p.cardStatus === 'cancelled' && s.status !== 'cancelled') {
      await SportsSession.updateOne({ _id: s._id, status: 'active' },
        { $set: { status: 'cancelled', cancelledAt: p.cancelledAt || new Date() } });
      s.status = 'cancelled';
      s.cancelledAt = p.cancelledAt || new Date();
    }
  }
  if (fixes.length) {
    try {
      await SportsSessionMember.bulkWrite(fixes, { ordered: false });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    console.warn(`[SPORTS_SESSION_RECONCILED] repaired ${fixes.length} member row(s) for user=${uid}`);
  }

  const out = plans
    .map(p => {
      const s = sessionByPlan.get(String(p._id));
      if (!s) return null;
      const m = mineBySession.get(String(s._id)) || { role: same(uid, p.creatorId) ? 'HOST' : 'PARTICIPANT' };
      // The list needs no participant profiles: counts and the plan's own fields only.
      return formatSession(s, p, m, svc._internal.formatPlan(p, uid), now);
    })
    .filter(Boolean)
    .sort((a, b) => (PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]) ||
      (new Date(a.plan.startTime) - new Date(b.plan.startTime)));

  return { success: true, status: 200, sessions: out, count: out.length };
}

/**
 * One session, for its members only. Anyone else — including someone who has
 * left — gets 403 NOT_A_SESSION_MEMBER with the plan id, so the app can take them
 * to the plan's public page instead. A block with the host hides it (404), as
 * Phase 1A hides the plan.
 */
async function getSession(user, sessionId) {
  if (!isValidId(sessionId)) return notFound();
  const session = await SportsSession.findById(sessionId).lean();
  if (!session) return notFound();
  const plan = await SportsPlan.findById(session.sportsPlanId).lean();
  if (!plan) return notFound();

  const svc = planService();
  if (await svc._internal.isBlockedPair(user, plan.creatorId)) return notFound();
  if (!includesId(plan.playersJoined, user._id)) {
    return fail(403, 'NOT_A_SESSION_MEMBER', 'Only people in this plan can open its session.',
      { sportsPlanId: String(plan._id) });
  }

  // Heal anything a sync write missed before answering.
  await followPlan('reconcile', plan, () => reconcile(plan, session));

  const formattedPlan = await svc._internal.formatWithPeople(plan, user);
  if (!formattedPlan.creator) return notFound();
  const member = await SportsSessionMember.findOne({ sessionId: session._id, userId: user._id }).lean();
  return { success: true, status: 200, session: formatSession(session, plan, member, formattedPlan) };
}

module.exports = {
  onPlanCreated,
  onPlayerJoined,
  onPlayerLeft,
  onPlanCancelled,
  sessionIdForMember,
  listMySessions,
  getSession,
  // For tests and the Phase 2A report.
  _internal: { ensureSession, reconcile, sessionPhase, LIST_GRACE_MS, MAX_SESSIONS },
};
