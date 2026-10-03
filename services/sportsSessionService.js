// services/sportsSessionService.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 2A. Sports Sessions: every Sports plan becomes one
// session whose members are the plan's players. Messages → Sessions lists them;
// Phase 3's group chat belongs to them (services/sportsChatService.js).
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
// PHASE 3. The hooks also write the chat's system messages — "<name> joined the
// session", "<name> left the session", "Sports session cancelled by the host" —
// once per REAL change: a join is announced only when this call is the one that
// made the member JOINED, so a retried request adds nothing. A join also sends
// the join notification. Messages → Sessions now lists chats, which outlive the
// plan (see the chat service's expiry rule), with unread counts and a preview.
//
// PHASE 4 (notifications) hooks in at onPlanCreated / onPlayerJoined /
// onPlayerLeft / onPlanCancelled: each is called exactly once per real change.
//
// PHASE 4. The cancellation push: markCancelled sends SPORTS_SESSION_CANCELLED
// to the participants (never the host) when THIS call made the change — the same
// guarded update that makes the chat say so once — so a retried cancel or a
// repair on read cannot send it twice. formatSession adds the derived lifecycle.
//
// CHAT ENHANCEMENT. onPlayerRemoved: the host removed someone (the plan write in
// sportsPlanService.removePlayer decides it). Their member row becomes REMOVED,
// their sockets are told and taken out of the room, and the chat says "<name>
// was removed from the session by the host" — once. removeMember() is the
// session-level entry point: host only, open chats only.
// -----------------------------------------------------------------------------
'use strict';

const mongoose            = require('mongoose');
const SportsPlan          = require('../models/SportsPlan');
const SportsSession       = require('../models/SportsSession');
const SportsSessionMember = require('../models/SportsSessionMember');

const { ObjectId } = mongoose.Types;

// Required lazily: these modules call into this one for every change.
const planService = () => require('./sportsPlanService');
const chat        = () => require('./sportsChatService');

const sportsSocket = () => require('../sockets/sportsSocket');
const SportsHiddenMessage = require('../models/SportsHiddenMessage');

const DAY_MS = 24 * 60 * 60 * 1000;
// A closed chat (expired or cancelled) stays in Messages → Sessions this long,
// marked as such, then drops off the list. Its history is kept either way.
const LIST_AFTER_CLOSE_MS = 7 * DAY_MS;
// Plans whose chat can be open, or recently closed, without any activity: the
// game's end + 7 days of chat + 7 days on the list, plus the longest plan (12 h).
const RECENT_PLAN_MS = 15 * DAY_MS;
const MAX_RECENT_PLANS = 100;
const MAX_MEMBER_ROWS  = 200;
const MAX_SESSIONS     = 50;

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
 * This is the GAME; the chat's own state (active / expired / cancelled) is
 * separate — a game can be over while its chat is very much alive.
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

/**
 * Makes [userId] a JOINED member — first join or rejoin. Idempotent.
 *
 * @returns the member when THIS call made them JOINED (with joinCount counting
 *   that join), or null when they already were — which is how a retried join is
 *   told apart from a real one without a transaction: the conditional update
 *   matches only a member who is not JOINED, and an upsert that collides with an
 *   existing JOINED row fails on the unique (sessionId, userId) index.
 */
async function markJoined(session, plan, userId, now = new Date()) {
  const role = same(userId, plan.creatorId) ? 'HOST' : 'PARTICIPANT';
  try {
    return await SportsSessionMember.findOneAndUpdate(
      { sessionId: session._id, userId, status: { $ne: 'JOINED' } },
      {
        $set:         { status: 'JOINED', role, leftAt: null, joinedAt: now },
        $setOnInsert: { sportsPlanId: plan._id },
        $inc:         { joinCount: 1 },
      },
      { upsert: true, new: true },
    ).lean();
  } catch (err) {
    if (isDuplicateKey(err)) return null;   // they are already JOINED
    throw err;
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
    await markCancelled(session, plan, plan.cancelledAt || now);
    repairs += 1;
  }
  if (repairs > 0) {
    console.warn(`[SPORTS_SESSION_RECONCILED] session=${session._id} plan=${plan._id} repairs=${repairs}`);
  }
  return repairs;
}

/**
 * active (or expired) → cancelled, once, and the chat says so. The announcement's
 * fixed key makes it appear once however many paths get here (the cancel hook,
 * a repair on read).
 */
async function markCancelled(session, plan, cancelledAt) {
  const res = await SportsSession.updateOne(
    { _id: session._id, status: { $ne: 'cancelled' } },
    { $set: { status: 'cancelled', cancelledAt } },
  );
  session.status = 'cancelled';
  session.cancelledAt = session.cancelledAt || cancelledAt;
  if (res.modifiedCount === 1) {
    await chat().announce(session, plan, 'SESSION_CANCELLED', plan.creatorId, 'SESSION_CANCELLED');
    // Phase 4: once, on the real transition. Fire-and-forget: a push can never
    // slow down or fail the cancellation.
    chat().notifySessionCancelled(plan, session).catch(() => {});
  }
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

/**
 * A plan was created: its session, with the host as the first member. No chat
 * message — the app shows "Waiting for others to join…" from the session itself.
 */
function onPlanCreated(plan) {
  return followPlan('create', plan, async () => {
    const session = await ensureSession(plan);
    await markJoined(session, plan, plan.creatorId);
    return session;
  });
}

/** A player joined: member row, "<name> joined the session", and the notification. */
function onPlayerJoined(plan, userId) {
  return followPlan('join', plan, async () => {
    const session = await ensureSession(plan);
    const joined = await markJoined(session, plan, userId);
    if (joined) {
      await chat().announce(session, plan, 'MEMBER_JOINED', userId, `MEMBER_JOINED:${userId}:${joined.joinCount}`);
      // Fire-and-forget: a push can never slow down or fail the join.
      chat().notifyMemberJoined(plan, session, userId).catch(() => {});
    }
    return session;
  });
}

/** A player left: the member row becomes LEFT and the chat says so (once). */
function onPlayerLeft(plan, userId) {
  return followPlan('leave', plan, async () => {
    const session = await ensureSession(plan);
    const left = await SportsSessionMember.findOneAndUpdate(
      { sessionId: session._id, userId, status: 'JOINED' },
      { $set: { status: 'LEFT', leftAt: new Date() } },
      { new: true },
    ).lean();
    if (left) {
      await chat().announce(session, plan, 'MEMBER_LEFT', userId, `MEMBER_LEFT:${userId}:${left.joinCount || 0}`);
    }
    return session;
  });
}

/**
 * The host removed a player (after the plan's own guarded update succeeded).
 * Their row becomes REMOVED; their open screens are told and every socket they
 * have leaves the room BEFORE the announcement, so they never receive it; the
 * others see "<name> was removed from the session by the host". Once only: the
 * guarded row update is the decision. Not chat activity.
 */
function onPlayerRemoved(plan, userId) {
  return followPlan('remove', plan, async () => {
    const session = await ensureSession(plan);
    const removed = await SportsSessionMember.findOneAndUpdate(
      { sessionId: session._id, userId, status: { $ne: 'REMOVED' } },
      { $set: { status: 'REMOVED', leftAt: new Date() } },
      { new: true },
    ).lean();
    sportsSocket().removeUserFromChat(String(plan._id), String(session._id), String(userId));
    if (removed) {
      await chat().announce(session, plan, 'MEMBER_REMOVED', userId, `MEMBER_REMOVED:${userId}:${removed.joinCount || 0}`);
      console.log(`[SPORTS_CHAT_MODERATION] member_removed session=${session._id} plan=${plan._id} user=${userId}`);
    }
    return session;
  });
}

/** The host cancelled: the session (and its chat) becomes read-only. Messages are kept. */
function onPlanCancelled(plan) {
  return followPlan('cancel', plan, async () => {
    const session = await ensureSession(plan);
    const cancelledAt = plan.cancelledAt || new Date();
    await markCancelled(session, plan, cancelledAt);
    return { ...session, status: 'cancelled', cancelledAt: session.cancelledAt || cancelledAt };
  });
}

/**
 * POST /sessions/:sessionId/members/:userId/remove — the host removes a player.
 * Host only (plan.creatorId), open chats only, never the host themself; the plan
 * write in sportsPlanService.removePlayer is the one decision.
 */
async function removeMember(user, sessionId, targetId) {
  const access = await chat().loadForMember(user, sessionId);
  if (access.error) return access.error;
  const { session, plan } = access;
  if (!same(plan.creatorId, user._id)) {
    return fail(403, 'NOT_SESSION_HOST', 'Only the host can remove people from this session.');
  }
  const closed = await chat().readOnlyRefusal(session, plan, Date.now());
  if (closed) return closed;
  return planService().removePlayer(user, plan._id, targetId);
}

/**
 * The session id to show a plan's member (plan responses carry it so the app can
 * open the session). Creates the session for a plan that predates Phase 2A.
 */
function sessionIdForMember(plan) {
  return followPlan('lookup', plan, async () => String((await ensureSession(plan))._id));
}

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * The one shape a session leaves this service in. [plan] is already formatted.
 * [extras]: lastMessage (preview), unreadCount — list responses only need these.
 */
function formatSession(session, plan, member, formattedPlan, now = Date.now(), extras = {}) {
  return {
    id:            String(session._id),
    sportsPlanId:  String(plan._id),
    status:        session.status,
    phase:         sessionPhase(plan, session, now),
    // Phase 4 (additive): lifecycle + lifecycleChangesAt; `phase` is unchanged.
    ...planService()._internal.lifecycleOf(plan, session, now),
    role:          member && member.role === 'HOST' ? 'HOST' : 'PARTICIPANT',
    memberCount:   (plan.playersJoined || []).length,
    playerLimit:   plan.playerLimit,
    joinedAt:      member && member.joinedAt ? new Date(member.joinedAt).toISOString() : null,
    lastMessageAt: session.lastMessageAt ? new Date(session.lastMessageAt).toISOString() : null,
    createdAt:     session.createdAt ? new Date(session.createdAt).toISOString() : null,
    cancelledAt:   session.cancelledAt ? new Date(session.cancelledAt).toISOString() : null,
    // Phase 3 — the chat.
    ...chat().chatInfo(session, plan, member, now),
    // What a long press on this card may do (LEAVE | HOST_CANCEL | DELETE); see removalOf.
    removal:       removalOf(session, plan, !!(member && member.role === 'HOST'), now),
    lastMessage:   extras.lastMessage || null,
    unreadCount:   extras.unreadCount || 0,
    plan:          formattedPlan,
  };
}

// ── Removing a session from your own list ─────────────────────────────────────
//
// What a long press on a Messages → Sessions card may do, decided here so the app
// never guesses (formatSession → `removal`):
//   LEAVE        a participant, the plan still open and not ended: the existing leave
//                (sportsPlanService.leavePlan). After it they are not in the plan, so
//                the session is no longer theirs to list.
//   HOST_CANCEL  the host of a plan still open and not ended: the host cannot leave
//                (the existing rule); only cancelling — a change for everyone, made
//                from the plan, never from a long press — would remove it.
//   DELETE       anything finished for this person: the chat is cancelled or expired
//                (no-join included), or the game has ended. Per user only: hideSession.
function removalOf(session, plan, isHost, now = Date.now()) {
  const state = chat().chatStateOf(session, plan, now);
  const finished = state !== 'active' || plan.cardStatus === 'cancelled' || now >= new Date(plan.endTime).getTime();
  if (finished) return 'DELETE';
  return isHost ? 'HOST_CANCEL' : 'LEAVE';
}

/** Hidden from this member's list, unless the chat has had qualifying activity since. */
function hiddenFromList(member, session) {
  if (!member || !member.hiddenAt) return false;
  const last = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0;
  return last <= new Date(member.hiddenAt).getTime();
}

/**
 * POST /sessions/:sessionId/hide — "Delete" a session from MY Sessions list. Members of
 * the plan only, and only once it is finished for them (removal DELETE): an open plan is
 * left or cancelled through the existing routes instead, never hidden around them.
 * Writes one field on the caller's own member row; nothing shared changes. Repeating it
 * is harmless.
 */
async function hideSession(user, sessionId, now = Date.now()) {
  if (!isValidId(sessionId)) return notFound();
  const session = await SportsSession.findById(sessionId).lean();
  if (!session) return notFound();
  const plan = await SportsPlan.findById(session.sportsPlanId).lean();
  if (!plan) return notFound();
  if (await planService()._internal.isBlockedPair(user, plan.creatorId)) return notFound();
  if (!includesId(plan.playersJoined, user._id)) {
    return fail(403, 'NOT_A_SESSION_MEMBER', 'Only people in this plan can remove its session.',
      { sportsPlanId: String(plan._id), removed: includesId(plan.kickedPlayers, user._id) });
  }
  const host = same(plan.creatorId, user._id);
  const removal = removalOf(session, plan, host, now);
  if (removal !== 'DELETE') {
    return fail(409, 'SESSION_STILL_ACTIVE', host
      ? 'You are hosting this plan. It can only be removed by cancelling it.'
      : 'This plan is still on. Leave it to remove it from your sessions.', { removal });
  }
  await SportsSessionMember.updateOne(
    { sessionId: session._id, userId: user._id },
    {
      $set:         { hiddenAt: new Date(now) },
      // A row a sync write missed: created as the reconcile repair would create it.
      $setOnInsert: { sportsPlanId: plan._id, status: 'JOINED', role: host ? 'HOST' : 'PARTICIPANT', joinedAt: new Date(now) },
    },
    { upsert: true },
  );
  return { success: true, status: 200, hidden: true, sessionId: String(session._id) };
}

/** When a closed chat stops being listed; null for an open one. */
function listedUntil(session, plan, state) {
  // No-join: an hour after it closed, whatever happens to it afterwards (a late cancel included).
  if (session.noJoinAt) return new Date(new Date(session.noJoinAt).getTime() + chat()._internal.NO_JOIN_VISIBLE_MS);
  if (state === 'cancelled') {
    const at = session.cancelledAt || plan.cancelledAt || session.updatedAt;
    return new Date(new Date(at).getTime() + LIST_AFTER_CLOSE_MS);
  }
  if (state === 'expired') {
    const at = session.expiredAt || chat().expiresAtOf(session, plan);
    return new Date(new Date(at).getTime() + LIST_AFTER_CLOSE_MS);
  }
  return null;
}

/**
 * The caller's Sports chats for Messages → Sessions.
 *
 * Found two ways, because a chat can now outlive its plan by months:
 *   1. every plan the caller is in whose game was in the last 15 days or is still
 *      to come — from the plan itself, so a missed session write never hides one;
 *   2. older plans whose chat has had activity in the last 14 days — from the
 *      caller's member rows, then checked against the plan (the authority).
 * Open chats first, most recent activity first; then closed ones (expired or
 * cancelled) for 7 days after they closed. A plan whose host is in a block with
 * the caller is left out, as Phase 1A leaves it out of every other read.
 *
 * A fixed number of queries whatever the count (plans, member rows, sessions,
 * blocks, the caller's rows, one unread aggregation, one user read for previews),
 * plus rare one-off repairs.
 */
async function listMySessions(user) {
  const uid   = user._id;
  const now   = Date.now();
  const svc   = planService();
  const c     = chat();
  const since = new Date(now - c._internal.INACTIVITY_MS - LIST_AFTER_CLOSE_MS);

  const recent = await SportsPlan.find({
    playersJoined: uid,
    startTime:     { $gt: new Date(now - RECENT_PLAN_MS) },
  }).sort({ startTime: -1 }).limit(MAX_RECENT_PLANS).lean();

  const myRows = await SportsSessionMember.find({ userId: uid, status: 'JOINED' })
    .sort({ updatedAt: -1 }).limit(MAX_MEMBER_ROWS).select('sessionId').lean();
  const talking = myRows.length
    ? await SportsSession.find({ _id: { $in: myRows.map(r => r.sessionId) }, lastMessageAt: { $gt: since } })
      .select('sportsPlanId').lean()
    : [];
  const seen = new Set(recent.map(p => String(p._id)));
  const olderIds = talking.map(s => s.sportsPlanId).filter(id => !seen.has(String(id)));
  // The plan decides membership: a stale member row cannot list someone else's chat.
  const older = olderIds.length ? await SportsPlan.find({ _id: { $in: olderIds }, playersJoined: uid }).lean() : [];

  const hidden = (await svc._internal.blockedCounterparts(user)).map(String);
  const hiddenSet = new Set(hidden);
  const plans = [...recent, ...older].filter(p => !hiddenSet.has(String(p.creatorId)));
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
    if (!s) continue;
    const m = mineBySession.get(String(s._id));
    if (!m || m.status !== 'JOINED') {
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
    if (p.cardStatus === 'cancelled' && s.status !== 'cancelled') {
      await markCancelled(s, p, p.cancelledAt || new Date());
    }
    // A chat seen expired for the first time is recorded as such.
    if (s.status === 'active') await c.persistExpiryIfDue(s, p, now);
  }
  if (fixes.length) {
    try {
      await SportsSessionMember.bulkWrite(fixes, { ordered: false });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    console.warn(`[SPORTS_SESSION_RECONCILED] repaired ${fixes.length} member row(s) for user=${uid}`);
  }

  // What is listed: open chats, and closed ones for a week after they closed.
  const entries = [];
  for (const p of plans) {
    const s = sessionByPlan.get(String(p._id));
    if (!s) continue;
    const state = c.chatStateOf(s, p, now);
    const until = listedUntil(s, p, state);
    if (until && now >= until.getTime()) continue;
    // Removed from this person's own list ("Delete"), with nothing newer since.
    if (hiddenFromList(mineBySession.get(String(s._id)), s)) continue;
    const m = mineBySession.get(String(s._id)) || { role: same(uid, p.creatorId) ? 'HOST' : 'PARTICIPANT' };
    const lastAt = s.lastMessage ? new Date(s.lastMessage.createdAt).getTime() : new Date(s.createdAt || 0).getTime();
    entries.push({ plan: p, session: s, member: m, open: state === 'active', lastAt });
  }
  entries.sort((a, b) => (Number(b.open) - Number(a.open)) || (b.lastAt - a.lastAt));
  const shown = entries.slice(0, MAX_SESSIONS);

  const unread = await c.unreadCounts(uid, shown, hidden);
  const previews = shown.map(e => e.session.lastMessage).filter(Boolean);
  const previewUsers = await c.usersFor(previews, [user]);
  // Newest messages this person hid for themselves ("delete for me"): one read.
  const previewIds = previews.map(p => p.messageId).filter(Boolean);
  const hiddenForMe = new Set(previewIds.length
    ? (await SportsHiddenMessage.find({ userId: uid, messageId: { $in: previewIds } }).select('messageId').lean())
      .map(h => String(h.messageId))
    : []);

  const out = shown.map(e => formatSession(
    e.session, e.plan, e.member,
    // The list needs no participant profiles: counts and the plan's own fields only.
    svc._internal.formatPlan(e.plan, uid),
    now,
    {
      lastMessage: c.formatPreview(e.session, previewUsers, hiddenSet, hiddenForMe),
      unreadCount: unread.get(String(e.session._id)) || 0,
    },
  ));
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
      { sportsPlanId: String(plan._id), removed: includesId(plan.kickedPlayers, user._id) });
  }

  // Heal anything a sync write missed before answering, and record an expiry.
  const now = Date.now();
  await followPlan('reconcile', plan, () => reconcile(plan, session));
  await followPlan('expiry', plan, () => chat().persistExpiryIfDue(session, plan, now));

  const formattedPlan = await svc._internal.formatWithPeople(plan, user);
  if (!formattedPlan.creator) return notFound();
  const member = await SportsSessionMember.findOne({ sessionId: session._id, userId: user._id }).lean();
  const hidden = new Set((await svc._internal.blockedCounterparts(user)).map(String));
  const users = session.lastMessage ? await chat().usersFor([session.lastMessage], [user]) : new Map();
  const lastId = session.lastMessage && session.lastMessage.messageId;
  const hiddenForMe = new Set(lastId && await SportsHiddenMessage.exists({ userId: user._id, messageId: lastId }) ? [String(lastId)] : []);
  return {
    success: true,
    status:  200,
    session: formatSession(session, plan, member, formattedPlan, now, {
      lastMessage: chat().formatPreview(session, users, hidden, hiddenForMe),
    }),
  };
}

// ── No-join outcome ───────────────────────────────────────────────────────────
//
// Joins close when the game starts (sportsPlanService.joinPlan: startTime > now), so
// from then on "nobody joined" is final. The every-minute Sports tick (cronJobs.js)
// finds plans that started, are not cancelled, and hold only their host; a plan
// nobody else EVER joined has its session closed once — status 'expired',
// noJoinAt — and the host gets one SPORTS_NO_JOIN push.
//
//   "ever joined": playersJoined is the host alone, kickedPlayers is empty (a removed
//   player had joined), and the session has no member row but the host's (rows are
//   kept when someone leaves, so a join that later left still counts). The same
//   membership records the rest of Sports uses; nothing new is counted.
//   Once: the session update is conditional (status 'active', noJoinAt null), so of
//   two ticks, two servers or a retry, exactly one changes it, and only that one
//   sends the push. A failed push is not retried (no duplicates, ever).
//   Not early: only plans that started at least NO_JOIN_GRACE_MS ago, so no server
//   (or clock) can still be accepting a join for it.
//   Bounded: plans that started within NO_JOIN_LOOKBACK_MS. Older ones (e.g. while
//   the server was down, or before this was deployed) keep the existing lifecycle:
//   no late "no one joined" news.
// Kill switch: SPORTS_NO_JOIN_ENABLED (default on), read on every tick.
const NO_JOIN_GRACE_MS    = 2 * 60 * 1000;
const NO_JOIN_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const MAX_NO_JOIN_PER_TICK = 100;
const noJoinEnabled = () => {
  const v = process.env.SPORTS_NO_JOIN_ENABLED;
  return v === undefined || v === null || String(v).trim() === '' || String(v).trim().toLowerCase() === 'true';
};

/** One plan: 'closed', or why not. */
async function closeIfNoJoin(plan, now) {
  const players = (plan.playersJoined || []).map(String);
  if (players.length !== 1 || !same(players[0], plan.creatorId)) return 'not_host_only';
  if ((plan.kickedPlayers || []).length > 0) return 'someone_joined';
  const session = await ensureSession(plan);
  if (!session || session.status !== 'active' || session.noJoinAt) return 'already_closed';
  if (await SportsSessionMember.exists({ sessionId: session._id, userId: { $ne: plan.creatorId } })) return 'someone_joined';

  const at = new Date(now);
  const res = await SportsSession.updateOne(
    { _id: session._id, status: 'active', noJoinAt: null },
    { $set: { status: 'expired', expiredAt: at, noJoinAt: at } },
  );
  if (res.modifiedCount !== 1) return 'already_closed';
  console.log(`[SPORTS_NO_JOIN] closed session=${session._id} plan=${plan._id}`);

  // The plan as it is now: a cancel that landed meanwhile gets no "no one joined" push.
  const fresh = await SportsPlan.findById(plan._id).lean();
  if (!fresh || fresh.cardStatus === 'cancelled') return 'closed';
  const closed = { ...session, status: 'expired', expiredAt: at, noJoinAt: at };
  await chat().notifyNoJoin(fresh, closed);
  // Open screens on the plan or its chat re-read it (the existing plan_updated event).
  try { sportsSocket().emitPlanChanged(planService()._internal.formatPlan(fresh, fresh.creatorId)); } catch (_) { /* display only */ }
  return 'closed';
}

/**
 * Called by the every-minute Sports tick. Never throws for one plan; returns counts.
 * [now] is for tests.
 */
async function tickNoJoin(now = Date.now()) {
  const summary = { checked: 0, closed: 0, skipped: {} };
  if (!noJoinEnabled()) return { ...summary, disabled: true };
  const plans = await SportsPlan.find({
    cardStatus: 'open',
    startTime: { $lte: new Date(now - NO_JOIN_GRACE_MS), $gt: new Date(now - NO_JOIN_LOOKBACK_MS) },
    'playersJoined.1': { $exists: false },
  }).sort({ startTime: 1 }).limit(MAX_NO_JOIN_PER_TICK).lean();
  for (const plan of plans) {
    summary.checked++;
    let outcome;
    try {
      outcome = await closeIfNoJoin(plan, now);
    } catch (err) {
      outcome = 'error';
      console.error(`[SPORTS_NO_JOIN] plan=${plan._id} failed: ${(err && err.name) || 'Error'}`);
    }
    if (outcome === 'closed') summary.closed++;
    else summary.skipped[outcome] = (summary.skipped[outcome] || 0) + 1;
  }
  // Counts and ids only.
  if (summary.closed || summary.skipped.error) console.log('[SPORTS_NO_JOIN]', JSON.stringify(summary));
  return summary;
}

module.exports = {
  onPlanCreated,
  onPlayerJoined,
  onPlayerLeft,
  onPlayerRemoved,
  onPlanCancelled,
  sessionIdForMember,
  listMySessions,
  getSession,
  removeMember,
  hideSession,
  tickNoJoin,
  // For the chat service, tests and the reports.
  _internal: {
    ensureSession, reconcile, markJoined, sessionPhase, LIST_AFTER_CLOSE_MS, RECENT_PLAN_MS, MAX_SESSIONS,
    closeIfNoJoin, NO_JOIN_GRACE_MS, NO_JOIN_LOOKBACK_MS, removalOf, hiddenFromList,
  },
};
