// services/roomEngagementActionService.js
// -----------------------------------------------------------------------------
// R5.2 — the Room ENGAGEMENT ENGINE.
//
//   R5.1 answers: "how engaged is this Room?"        (derived state)
//   R5.2 answers: "should Humrah do anything?"       (deterministic decision)
//
// Everything here is a pure rule + an existing primitive. No AI, no LLM, no
// free-text interpretation, no behavioural profiling, no new Mongo collection.
//
// It NEVER:
//   - changes Room lifecycle status, membership, capacity or discovery
//   - writes an automated chat message into a Room (that is a future decision)
//   - touches Phase 2.1 message-notification cooldowns, typing, reactions or
//     read state
//   - runs at all unless ROOM_ENGAGEMENT_ENABLED=true
//
// It fails CLOSED: anything missing, ambiguous or unavailable => NO_ACTION.
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const RoomMessage = require('../models/RoomMessage');
const User = require('../models/User');
const Notification = require('../models/Notification');
const redisService = require('./redisService');
const { getUsersInsideRoom } = require('./roomPresenceService');
const { sendDataFcm } = require('../utils/fcmHelper');
const {
  STATE,
  THRESHOLDS,
  evaluateRooms,
  recordStateTransition,
  stateKey,
} = require('./roomEngagementService');
const { cooldownKeyFor: messageCooldownKeyFor } = require('./roomMessageNotificationService');

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  return String(v).trim().toLowerCase() === 'true';
};

/**
 * Every tunable lives here. Nothing engagement-related is hard-coded anywhere else.
 *
 * Window arithmetic note: R5.1 classifies a Room QUIET between HEALTHY_WINDOW (6h)
 * and QUIET_WINDOW (24h) after its last message, and humrahRoomExpiryJob flips the
 * Room to INACTIVE at exactly 24h. The re-engagement opportunity therefore lives in
 * [6h, 24h) and closes on its own — engagement can never outlive the lifecycle.
 */
const ENGAGEMENT_CONFIG = {
  // Default OFF. Must be switched on deliberately, per deployment, and only once
  // the Android build that understands ROOM_REENGAGEMENT has shipped.
  ENABLED: bool(process.env.ROOM_ENGAGEMENT_ENABLED, false),
  // Evaluate + decide + log, but send nothing. For safe production rollout.
  DRY_RUN: bool(process.env.ROOM_ENGAGEMENT_DRY_RUN, false),

  INTERVAL_MINUTES: num(process.env.ROOM_ENGAGEMENT_INTERVAL_MINUTES, 60),
  // Upper bound on Rooms pulled into one evaluation pass (protects Mongo).
  MAX_ROOMS_SCANNED: num(process.env.ROOM_ENGAGEMENT_MAX_ROOMS_SCANNED, 500),
  // Upper bound on Rooms actually acted on in one pass (protects users + FCM).
  MAX_ACTIONS_PER_RUN: num(process.env.ROOM_ENGAGEMENT_MAX_ACTIONS_PER_RUN, 20),

  // Anti-spam. A Room may be re-engaged at most once per this window...
  ROOM_COOLDOWN_HOURS: num(process.env.ROOM_ENGAGEMENT_ROOM_COOLDOWN_HOURS, 24),
  // ...a user may receive at most one engagement push per this window, across ALL
  // Rooms (a member of four quiet Rooms is not notified four times)...
  USER_COOLDOWN_HOURS: num(process.env.ROOM_ENGAGEMENT_USER_COOLDOWN_HOURS, 12),
  // ...and at most this many engagement pushes per rolling 24h.
  USER_DAILY_MAX: num(process.env.ROOM_ENGAGEMENT_USER_DAILY_MAX, 2),

  // Room-level quality gates.
  MIN_JOINED_MEMBERS: num(process.env.ROOM_ENGAGEMENT_MIN_MEMBERS, 2),
  MIN_RECENT_PARTICIPANTS: num(process.env.ROOM_ENGAGEMENT_MIN_PARTICIPANTS, 2),

  // Only act on a genuine transition INTO quiet (HEALTHY→QUIET / ACTIVE→QUIET).
  // Without this, a Room that has been quiet for six hours looks "newly quiet"
  // on every cycle, and the first run after a deploy would act on every Room.
  REQUIRE_TRANSITION: bool(process.env.ROOM_ENGAGEMENT_REQUIRE_TRANSITION, true),

  // The last person who spoke is waiting for a reply, not for a reminder.
  EXCLUDE_LAST_SENDER: bool(process.env.ROOM_ENGAGEMENT_EXCLUDE_LAST_SENDER, true),

  // R5.3 — how long after a delivered nudge a Room's recovery may still be
  // attributed to it. Outside this window a Room becoming active again is just a
  // Room becoming active again, and is NOT claimed as a re-engagement success.
  ATTRIBUTION_WINDOW_HOURS: num(process.env.ROOM_ENGAGEMENT_ATTRIBUTION_WINDOW_HOURS, 24),

  LOCK_TTL_SECONDS: num(process.env.ROOM_ENGAGEMENT_LOCK_TTL_SECONDS, 300),
  // Short claim held while a Room's action is executing. Promoted to the full
  // Room cooldown only after a notification is actually delivered.
  CLAIM_TTL_SECONDS: num(process.env.ROOM_ENGAGEMENT_CLAIM_TTL_SECONDS, 120),
};

/** The complete action vocabulary. R5.2 deliberately ships exactly one action. */
const ACTION = {
  NONE: 'NO_ACTION',
  QUIET_ROOM_REENGAGEMENT: 'QUIET_ROOM_REENGAGEMENT',
};

/** Why the engine decided what it decided. Every decision carries exactly one. */
const REASON = {
  ACTIVE_ROOM: 'ACTIVE_ROOM',
  HEALTHY_ROOM: 'HEALTHY_ROOM',
  DORMANT_ROOM: 'DORMANT_ROOM',
  LIFECYCLE_INELIGIBLE: 'LIFECYCLE_INELIGIBLE',
  MEMBERS_PRESENT: 'MEMBERS_PRESENT',
  ENGAGEMENT_COOLDOWN: 'ENGAGEMENT_COOLDOWN',
  INSUFFICIENT_MEMBERS: 'INSUFFICIENT_MEMBERS',
  INSUFFICIENT_PARTICIPANTS: 'INSUFFICIENT_PARTICIPANTS',
  NO_STATE_TRANSITION: 'NO_STATE_TRANSITION',
  NO_ELIGIBLE_TARGETS: 'NO_ELIGIBLE_TARGETS',
  EVALUATION_UNAVAILABLE: 'EVALUATION_UNAVAILABLE',
  ELIGIBLE: 'ELIGIBLE',
};

/** Lifecycle statuses a Room must be in before engagement may even be considered. */
const ENGAGEABLE_LIFECYCLE_STATUSES = ['ACTIVE', 'FULL'];

// ── Redis keys ───────────────────────────────────────────────────────────────
// Deliberately namespaced under `engagement:` so they can never collide with, or
// be mistaken for, Phase 2.1's `room_message_notification_cooldown:<roomId>:<userId>`.
const roomCooldownKey = (action, roomId) => `engagement:${action}:room:${roomId}`;
const roomClaimKey = (action, roomId) => `lock:engagement:${action}:room:${roomId}`;
const userCooldownKey = (userId) => `engagement:cooldown:user:${userId}`;
const userDailyKey = (userId) => `engagement:daily:user:${userId}`;
// R5.3 — the open attribution window for one delivered nudge. Its TTL *is* the
// window: once it expires the Room can no longer be credited to a nudge.
const outcomeKey = (roomId) => `engagement:outcome:room:${roomId}`;
const WORKER_LOCK_KEY = 'lock:room_engagement_worker';

const hours = (h) => h * 60 * 60;

/**
 * R5.3 — the ONE place engagement observability is emitted.
 *
 * There is no PostHog client on this backend (verified: no dependency, no
 * initialisation anywhere) and R5.3 does not add one. Delivery is already
 * recorded durably in the Notification collection; this emits the structured
 * counterpart under the existing [ROOM_ENGAGEMENT] prefix so a funnel can be
 * reconstructed from logs + Notification rows + the Android PostHog events,
 * joined on notificationId.
 *
 * Observational only. It can never throw into a caller, and nothing branches on
 * its result — engagement behaviour is identical whether or not this succeeds.
 * Properties are constructed explicitly: ids, counts and enums only. Never a
 * Mongoose document, message text, name, email, token or questionnaire data.
 */
function emitEngagementEvent(event, props = {}) {
  try {
    console.log('[ROOM_ENGAGEMENT]', JSON.stringify({
      event,
      // Dry-run output must never be mistaken for real production activity.
      dryRun: ENGAGEMENT_CONFIG.DRY_RUN === true,
      at: new Date().toISOString(),
      ...props,
    }));
  } catch (_) {
    // Observability must never affect engagement. Swallow deliberately.
  }
}

/**
 * THE DECISION. Pure function — no I/O, no clock reads beyond what is passed in.
 * Exported so the decision matrix can be tested exhaustively without a database,
 * Redis, Socket.IO or FCM.
 *
 * @param {object} input
 * @param {object} input.snapshot        R5.1 engagement snapshot (or null)
 * @param {string} input.lifecycleStatus HumrahRoom.status
 * @param {number} input.joinedMemberCount
 * @param {number} input.presentMemberCount  members currently inside the Room
 * @param {boolean} input.onCooldown
 * @param {?string} input.previousState  last observed engagement state (or null)
 * @param {number} input.cooldownUntil   epoch ms, 0 when not on cooldown
 * @returns {{roomId:?string, state:?string, action:string, shouldAct:boolean, reason:string, cooldownUntil:?number}}
 */
function decideRoomAction(input = {}) {
  const {
    snapshot,
    lifecycleStatus,
    joinedMemberCount,
    presentMemberCount,
    onCooldown,
    previousState,
    cooldownUntil,
  } = input;

  const decision = (reason, extra = {}) => ({
    roomId: snapshot ? snapshot.roomId : (input.roomId ? String(input.roomId) : null),
    state: snapshot ? snapshot.state : null,
    action: ACTION.NONE,
    shouldAct: false,
    reason,
    cooldownUntil: cooldownUntil || null,
    ...extra,
  });

  // Fail closed: no engagement evaluation => no decision.
  if (!snapshot || !snapshot.state) return decision(REASON.EVALUATION_UNAVAILABLE);

  // Lifecycle gate FIRST, exactly as R5.1 does. Engagement must never resurrect a
  // Room that the lifecycle has retired, and must never change its status.
  if (!ENGAGEABLE_LIFECYCLE_STATUSES.includes(lifecycleStatus)) {
    return decision(REASON.LIFECYCLE_INELIGIBLE);
  }

  switch (snapshot.state) {
    case STATE.ACTIVE:
      // People are talking. Do not interrupt a working conversation.
      return decision(REASON.ACTIVE_ROOM);

    case STATE.HEALTHY:
      // Genuine recent participation. Silence is the correct product behaviour.
      return decision(REASON.HEALTHY_ROOM);

    case STATE.DORMANT:
      // Nothing meaningful to revive. Do not aggressively re-engage.
      return decision(REASON.DORMANT_ROOM);

    case STATE.QUIET:
      break; // the only engagement opportunity in R5.2

    default:
      return decision(REASON.EVALUATION_UNAVAILABLE);
  }

  // ── QUIET Room: work through the blockers in cheapest-first order ──────────

  // Never tell someone who is literally inside the Room to come back to it.
  if (presentMemberCount > 0) return decision(REASON.MEMBERS_PRESENT);

  if (onCooldown) return decision(REASON.ENGAGEMENT_COOLDOWN);

  if ((joinedMemberCount || 0) < ENGAGEMENT_CONFIG.MIN_JOINED_MEMBERS) {
    return decision(REASON.INSUFFICIENT_MEMBERS);
  }

  // "Meaningful previous participation" — a Room where one person posted once and
  // nobody replied is not a stalled conversation, it never was one.
  if ((snapshot.participatingMemberCount || 0) < ENGAGEMENT_CONFIG.MIN_RECENT_PARTICIPANTS) {
    return decision(REASON.INSUFFICIENT_PARTICIPANTS);
  }

  // A Room that has been QUIET for hours is not "newly quiet" on every cycle.
  if (ENGAGEMENT_CONFIG.REQUIRE_TRANSITION && previousState === STATE.QUIET) {
    return decision(REASON.NO_STATE_TRANSITION);
  }
  // First ever observation of a Room records its state without acting, so a deploy
  // cannot fan out to every quiet Room at once.
  if (ENGAGEMENT_CONFIG.REQUIRE_TRANSITION && !previousState) {
    return decision(REASON.NO_STATE_TRANSITION);
  }

  return {
    roomId: snapshot.roomId,
    state: snapshot.state,
    action: ACTION.QUIET_ROOM_REENGAGEMENT,
    shouldAct: true,
    reason: REASON.ELIGIBLE,
    cooldownUntil: null,
  };
}

/** R5.3 — how a delivered nudge turned out, judged on Room activity alone. */
const OUTCOME = {
  REVIVED: 'ROOM_REVIVED',
  ACTIVITY_NO_REVIVAL: 'ACTIVITY_NO_REVIVAL',
  NO_ACTIVITY: 'NO_ACTIVITY',
  PENDING: 'PENDING',
};

/**
 * R5.3 — THE REVIVAL RULE. Pure, deterministic, exported for direct testing.
 *
 * A delivered nudge counts as ROOM_REVIVED only when ALL of these hold:
 *
 *   1. the Room is engagement-ACTIVE or engagement-HEALTHY per R5.1 — R5.1's
 *      existing definition is reused verbatim, so "engaged" is never redefined;
 *   2. at least MIN_PARTICIPANTS_FOR_CONVERSATION (2) distinct people have
 *      posted, i.e. it is a conversation and not one person talking; and
 *   3. the newest activity is strictly NEWER than the moment the nudge was
 *      delivered — the clause that makes this a measurement rather than a
 *      flattering coincidence. Without it, a Room whose pre-existing messages
 *      already sat inside R5.1's 24h window would be credited to a nudge that
 *      changed nothing.
 *
 * Delivery is not success. An open is not success. Only a Room that is talking
 * again, with more than one person, after we nudged it, is success.
 *
 * Outside the attribution window nothing is claimed at all.
 */
function classifyRevival(marker, snapshot, now = Date.now()) {
  if (!marker || !marker.sentAt || !snapshot) return OUTCOME.PENDING;

  const windowMs = hours(ENGAGEMENT_CONFIG.ATTRIBUTION_WINDOW_HOURS) * 1000;
  if (now - marker.sentAt > windowMs) return OUTCOME.PENDING; // expired, claim nothing

  const lastActivity = snapshot.lastActivityAt ? Date.parse(snapshot.lastActivityAt) : NaN;
  const activityAfterSend = Number.isFinite(lastActivity) && lastActivity > marker.sentAt;
  if (!activityAfterSend) return OUTCOME.NO_ACTIVITY;

  const multiParty = (snapshot.participatingMemberCount || 0)
    >= THRESHOLDS.MIN_PARTICIPANTS_FOR_CONVERSATION;
  const conversational = snapshot.state === STATE.ACTIVE || snapshot.state === STATE.HEALTHY;

  return (multiParty && conversational) ? OUTCOME.REVIVED : OUTCOME.ACTIVITY_NO_REVIVAL;
}

/**
 * Deterministic copy, matching Phase 2.1's tone. No AI, no personalization, no
 * psychological framing, no counts of who ignored whom.
 */
function buildReengagementCopy({ topic }) {
  const where = topic && String(topic).trim() ? String(topic).trim() : 'your Humrah Room';
  return {
    title: `Your Humrah Room is quiet`,
    body: `The conversation in ${where} has gone quiet. Tap to pick it back up.`,
  };
}

/**
 * Per-user eligibility. Mirrors the Phase 2.1 rules exactly so engagement can
 * never reach someone Room messages would not reach.
 * @returns {?string} skip reason, or null when eligible
 */
function userSkipReason(user) {
  if (!user) return 'user_missing';
  if (user.status !== 'ACTIVE') return 'user_not_active';
  if (user.suspensionInfo?.isSuspended === true) return 'user_suspended';
  if (user.pushNotifications === false) return 'push_disabled';
  const tokens = capableTokens(user);
  if (tokens.length === 0) return 'no_capable_device';
  return null;
}

function capableTokens(user) {
  return [...new Set(
    (user?.fcmDevices || [])
      .filter(d => d.supportsHumrahRooms === true && typeof d.token === 'string' && d.token.trim())
      .map(d => d.token)
  )];
}

/**
 * Rooms worth evaluating this pass: lifecycle-engageable, at least two members,
 * and with activity inside R5.1's 24h engagement horizon.
 *
 * Served entirely by the existing { status: 1, lastMessageAt: 1 } index — R5.2
 * adds no index. Deliberately NOT narrowed to the 6h–24h QUIET band, because the
 * engine must observe ACTIVE/HEALTHY states in order to detect the transition
 * INTO quiet.
 */
async function findEvaluableRooms(now = Date.now(), limit = ENGAGEMENT_CONFIG.MAX_ROOMS_SCANNED) {
  const horizon = new Date(now - THRESHOLDS.QUIET_WINDOW_MS);
  return HumrahRoom.find({
    status: { $in: ENGAGEABLE_LIFECYCLE_STATUSES },
    lastMessageAt: { $gt: horizon },
    memberCount: { $gte: ENGAGEMENT_CONFIG.MIN_JOINED_MEMBERS },
  })
    .select('_id status topic memberCount lastMessageAt')
    .sort({ lastMessageAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * Executes ONE re-engagement action for one Room.
 *
 * Idempotency + concurrency: the action is claimed with an atomic Redis
 * SET NX EX (redisService.acquireLock). Two workers evaluating the same Room at
 * the same instant cannot both win the claim, so only one can notify. The claim
 * is short-lived; it is promoted to the full Room cooldown only after a
 * notification is actually delivered, and released on failure so a later pass can
 * legitimately retry (the same rule Phase 2 uses for invitations).
 *
 * Always resolves. Never throws into the scheduler.
 */
async function executeReengagement(io, room, snapshot, context = {}) {
  const roomId = String(room._id);
  const result = {
    roomId,
    action: ACTION.QUIET_ROOM_REENGAGEMENT,
    executed: false,
    skipReason: null,
    targetsConsidered: 0,
    targetsNotified: 0,
    targetsSkipped: {},
    fcmsFailed: 0,
    invalidTokensRemoved: 0,
  };
  const skip = (r) => { result.targetsSkipped[r] = (result.targetsSkipped[r] || 0) + 1; };

  const claimKey = roomClaimKey(ACTION.QUIET_ROOM_REENGAGEMENT, roomId);
  let claimed = false;

  try {
    claimed = await redisService.acquireLock(claimKey, ENGAGEMENT_CONFIG.CLAIM_TTL_SECONDS);
    if (!claimed) {
      result.skipReason = 'already_claimed';
      return result;
    }

    const members = context.membersByRoom?.get(roomId)
      || (await RoomMember.find({ roomId, status: 'JOINED' }).select('userId').lean());
    const memberIds = members.map(m => String(m.userId));
    if (memberIds.length < ENGAGEMENT_CONFIG.MIN_JOINED_MEMBERS) {
      result.skipReason = 'insufficient_members';
      return result;
    }

    // Presence is resolved only for Rooms that survived the cheap gates, then the
    // SAME pure decision function is re-run with it. The matrix stays the single
    // authority on whether to act; this is just the expensive input arriving late.
    const inside = await getUsersInsideRoom(io, roomId, memberIds);
    const finalDecision = decideRoomAction({
      roomId,
      snapshot,
      lifecycleStatus: room.status,
      joinedMemberCount: memberIds.length,
      presentMemberCount: inside.size,
      onCooldown: false, // already claimed above; the claim is the cooldown authority
      previousState: context.previousStateByRoom?.get(roomId) || STATE.HEALTHY,
    });
    if (!finalDecision.shouldAct) {
      result.skipReason = finalDecision.reason === REASON.MEMBERS_PRESENT
        ? 'members_present'
        : String(finalDecision.reason).toLowerCase();
      return result;
    }

    let candidateIds = memberIds.filter(id => !inside.has(id));
    if (ENGAGEMENT_CONFIG.EXCLUDE_LAST_SENDER && context.lastSenderByRoom?.has(roomId)) {
      const lastSender = context.lastSenderByRoom.get(roomId);
      candidateIds = candidateIds.filter(id => id !== lastSender);
    }
    result.targetsConsidered = candidateIds.length;
    if (candidateIds.length === 0) {
      result.skipReason = 'no_eligible_targets';
      return result;
    }

    const users = context.usersById
      ? candidateIds.map(id => context.usersById.get(id)).filter(Boolean)
      : await User.find({ _id: { $in: candidateIds } })
          .select('_id status suspensionInfo pushNotifications fcmDevices')
          .lean();
    const userById = new Map(users.map(u => [String(u._id), u]));

    const { title, body } = buildReengagementCopy({ topic: room.topic });
    let delivered = 0;

    for (const uid of candidateIds) {
      try {
        const user = userById.get(uid);
        const reason = userSkipReason(user);
        if (reason) { skip(reason); continue; }

        // Cross-Room per-user throttle.
        if (await redisService.get(userCooldownKey(uid))) { skip('user_cooldown'); continue; }

        // Do not pile an engagement push on top of a Phase 2.1 message push.
        // Read-only: this never writes or clears the Phase 2.1 key.
        if (await redisService.get(messageCooldownKeyFor(roomId, uid))) {
          skip('recent_message_notification');
          continue;
        }

        // Rolling daily cap.
        const dailyCount = await redisService.get(userDailyKey(uid));
        if (typeof dailyCount === 'number' && dailyCount >= ENGAGEMENT_CONFIG.USER_DAILY_MAX) {
          skip('user_daily_max');
          continue;
        }

        if (ENGAGEMENT_CONFIG.DRY_RUN) { skip('dry_run'); continue; }

        const notification = await new Notification({
          userId: uid,
          title,
          message: body,
          type: 'ROOM_REENGAGEMENT',
          createdBy: 'system',
          roomId,
        }).save();

        const fcm = await sendDataFcm(uid, capableTokens(user), {
          type: 'ROOM_REENGAGEMENT',
          roomId,
          notificationId: String(notification._id),
          title,
          body,
        });
        result.invalidTokensRemoved += fcm.invalidTokensRemoved;

        if (!fcm.delivered) {
          result.fcmsFailed++;
          notification.failureReason = fcm.error || 'fcm_delivery_failed';
          await notification.save();
          skip('fcm_failed');
          continue; // no user cooldown burned — a later pass may retry
        }

        notification.deliveredAt = new Date();
        await notification.save();

        await redisService.set(userCooldownKey(uid), '1', hours(ENGAGEMENT_CONFIG.USER_COOLDOWN_HOURS));
        await redisService.incrementWithWindow(userDailyKey(uid), hours(24));
        delivered++;

        // R5.3 — emitted ONLY past the fcm.delivered check above, so an attempted
        // send is never counted as a delivered one. notificationId is the join key
        // the Android open/participation events echo back.
        emitEngagementEvent('room_reengagement_sent', {
          roomId,
          action: ACTION.QUIET_ROOM_REENGAGEMENT,
          engagementState: snapshot?.state || null,
          lifecycleStatus: room.status,
          notificationId: String(notification._id),
          delivered: true,
        });
      } catch (perUserErr) {
        skip('recipient_error');
        console.error('[ROOM_ENGAGEMENT] recipient error:', perUserErr.message);
      }
    }

    result.targetsNotified = delivered;

    if (delivered > 0) {
      // Promote the short claim to the full Room cooldown, and only now.
      await redisService.set(
        roomCooldownKey(ACTION.QUIET_ROOM_REENGAGEMENT, roomId),
        { at: Date.now(), action: ACTION.QUIET_ROOM_REENGAGEMENT },
        hours(ENGAGEMENT_CONFIG.ROOM_COOLDOWN_HOURS)
      );

      // R5.3 — open the attribution window. The marker records only what is needed
      // to judge revival later: when, how many were nudged, and the participation
      // level at the moment of sending (so "already multi-party" can't be claimed
      // as a revival). It expires on its own; nothing has to clean it up.
      await redisService.set(
        outcomeKey(roomId),
        {
          sentAt: Date.now(),
          action: ACTION.QUIET_ROOM_REENGAGEMENT,
          targetsNotified: delivered,
          participantsAtSend: snapshot?.participatingMemberCount ?? 0,
        },
        hours(ENGAGEMENT_CONFIG.ATTRIBUTION_WINDOW_HOURS)
      );

      result.executed = true;
    } else if (!result.skipReason) {
      result.skipReason = 'no_eligible_targets';
    }

    return result;
  } catch (err) {
    result.skipReason = 'execution_error';
    result.error = err.message;
    console.error('[ROOM_ENGAGEMENT] action failed:', err.message);
    return result;
  } finally {
    // Release the claim either way: on success the separate cooldown key now
    // holds the Room shut for 24h; on failure the Room stays retryable.
    if (claimed) {
      try { await redisService.releaseLock(claimKey); } catch (_) { /* TTL clears it */ }
    }
  }
}

/**
 * ONE full engagement pass. Batch-shaped end to end:
 *
 *   1 Mongo query  → evaluable Rooms
 *   1 aggregation  → R5.1 evaluateRooms() for ALL of them
 *   1 Redis mget   → previous engagement states
 *   1 Redis mget   → Room cooldowns
 *   1 Mongo query  → JOINED members of the surviving candidates only
 *   1 Mongo query  → last message sender of those Rooms only
 *   1 Mongo query  → those Rooms' users only
 *   then per surviving Room: presence + claim + sends
 *
 * There is no per-Room Mongo query anywhere in the loop.
 * Always resolves — one broken Room never stops the others.
 */
async function runEngagementPass(options = {}) {
  const summary = {
    event: 'room_engagement_pass',
    started: new Date().toISOString(),
    enabled: ENGAGEMENT_CONFIG.ENABLED,
    dryRun: ENGAGEMENT_CONFIG.DRY_RUN,
    roomsScanned: 0,
    roomsEvaluated: 0,
    stateTransitions: 0,
    candidates: 0,
    actionsExecuted: 0,
    notificationsSent: 0,
    roomsRevived: 0,
    roomsActiveNotRevived: 0,
    roomsFailed: 0,
    decisionCounts: {},
    durationMs: 0,
    skippedReason: null,
  };
  const started = Date.now();
  const io = options.io || null;
  const countDecision = (reason) => {
    summary.decisionCounts[reason] = (summary.decisionCounts[reason] || 0) + 1;
  };

  if (!ENGAGEMENT_CONFIG.ENABLED && options.force !== true) {
    summary.skippedReason = 'engagement_disabled';
    summary.durationMs = Date.now() - started;
    return summary;
  }

  // Engagement needs Redis for BOTH atomic cooldowns and trustworthy cross-instance
  // presence. Without it we cannot guarantee "one action" or "nobody is inside", so
  // we decline to act rather than risk duplicate or misdirected notifications.
  if (!redisAvailable()) {
    summary.skippedReason = 'redis_unavailable';
    summary.durationMs = Date.now() - started;
    console.warn('[ROOM_ENGAGEMENT] Skipped: Redis unavailable — cannot guarantee idempotency or presence.');
    return summary;
  }

  let lockAcquired = false;
  try {
    lockAcquired = await redisService.acquireLock(WORKER_LOCK_KEY, ENGAGEMENT_CONFIG.LOCK_TTL_SECONDS);
  } catch (err) {
    summary.skippedReason = 'lock_error';
    summary.durationMs = Date.now() - started;
    console.error('[ROOM_ENGAGEMENT] Lock acquisition failed:', err.message);
    return summary;
  }
  if (!lockAcquired) {
    summary.skippedReason = 'already_running';
    summary.durationMs = Date.now() - started;
    return summary;
  }

  try {
    const now = options.now || Date.now();

    const rooms = await findEvaluableRooms(now, ENGAGEMENT_CONFIG.MAX_ROOMS_SCANNED);
    summary.roomsScanned = rooms.length;
    if (rooms.length === 0) {
      summary.durationMs = Date.now() - started;
      return summary;
    }

    // R5.1 batch evaluation — one aggregation for every Room in the pass.
    const snapshots = await evaluateRooms(rooms, { now });
    summary.roomsEvaluated = snapshots.length;
    const snapshotByRoom = new Map(snapshots.map(s => [s.roomId, s]));

    // Previous engagement states, batched (R5.1's key, not a second tracker).
    const roomIds = rooms.map(r => String(r._id));
    const prevStates = await safeGetMany(roomIds.map(stateKey));
    const previousStateFor = (roomId) => prevStates.get(stateKey(roomId)) || null;

    // Room cooldowns, batched.
    const cooldowns = await safeGetMany(
      roomIds.map(id => roomCooldownKey(ACTION.QUIET_ROOM_REENGAGEMENT, id))
    );

    // ── Decide for every Room (cheap, pure) ─────────────────────────────────
    const decisions = [];
    for (const room of rooms) {
      const roomId = String(room._id);
      const snapshot = snapshotByRoom.get(roomId);
      const decision = decideRoomAction({
        roomId,
        snapshot,
        lifecycleStatus: room.status,
        joinedMemberCount: room.memberCount,
        // Presence is resolved only for Rooms that survive the cheap gates; at this
        // stage it is unknown, so it cannot yet block a decision.
        presentMemberCount: 0,
        onCooldown: cooldowns.has(roomCooldownKey(ACTION.QUIET_ROOM_REENGAGEMENT, roomId)),
        previousState: previousStateFor(roomId),
      });
      countDecision(decision.reason);
      decisions.push({ room, snapshot, decision });

      // R5.3 — record the decision that actually leads to an action. Blocked and
      // no-op decisions are counted into decisionCounts above but NOT emitted
      // individually: an hourly "NO_ACTION" line per Room is how logs become a
      // landfill nobody reads.
      if (decision.shouldAct) {
        emitEngagementEvent('room_engagement_action_decided', {
          roomId,
          action: decision.action,
          reason: decision.reason,
          engagementState: snapshot ? snapshot.state : null,
          lifecycleStatus: room.status,
          previousState: previousStateFor(roomId),
        });
      }
    }

    // ── R5.3: did earlier nudges work? ────────────────────────────────────────
    // Judged on the SAME snapshots already computed above, so measurement costs
    // one batched Redis read and zero extra Mongo queries.
    await measureRevivals(rooms, snapshotByRoom, now, summary);

    // ── Record genuine state transitions (only where the state actually moved) ─
    for (const { snapshot, room } of decisions) {
      if (!snapshot) continue;
      if (previousStateFor(String(room._id)) === snapshot.state) continue;
      try {
        const t = await recordStateTransition(snapshot);
        if (t) summary.stateTransitions++;
      } catch (err) {
        console.error('[ROOM_ENGAGEMENT] transition failed:', err.message);
      }
    }

    const candidates = decisions
      .filter(d => d.decision.shouldAct)
      .slice(0, ENGAGEMENT_CONFIG.MAX_ACTIONS_PER_RUN);
    summary.candidates = candidates.length;
    if (candidates.length === 0) {
      summary.durationMs = Date.now() - started;
      logPass(summary);
      return summary;
    }

    // ── Batch-load everything the surviving candidates need ─────────────────
    const candidateRoomIds = candidates.map(c => c.room._id);
    const context = await loadActionContext(candidateRoomIds);
    // The state each Room was in BEFORE this pass recorded its transition, so the
    // execution-time re-decision sees the same history the first decision saw.
    context.previousStateByRoom = new Map(
      candidates.map(c => [String(c.room._id), previousStateFor(String(c.room._id))])
    );

    for (const { room, snapshot } of candidates) {
      try {
        const outcome = await executeReengagement(io, room, snapshot, context);
        if (outcome.executed) {
          summary.actionsExecuted++;
          summary.notificationsSent += outcome.targetsNotified;
          console.log('[ROOM_ENGAGEMENT]', JSON.stringify({
            event: 'engagement_action_performed',
            roomId: outcome.roomId,
            action: outcome.action,
            state: snapshot.state,
            targetsConsidered: outcome.targetsConsidered,
            targetsNotified: outcome.targetsNotified,
          }));
        } else {
          countDecision(`blocked_${outcome.skipReason || 'unknown'}`);
        }
      } catch (roomErr) {
        // One Room's failure must never stop the pass.
        summary.roomsFailed++;
        console.error('[ROOM_ENGAGEMENT] room failed:', roomErr.message);
      }
    }

    summary.durationMs = Date.now() - started;
    logPass(summary);
    return summary;
  } catch (err) {
    summary.skippedReason = 'pass_error';
    summary.error = err.message;
    summary.durationMs = Date.now() - started;
    console.error('[ROOM_ENGAGEMENT] pass failed:', err.message);
    return summary;
  } finally {
    if (lockAcquired) {
      try { await redisService.releaseLock(WORKER_LOCK_KEY); } catch (_) { /* TTL clears it */ }
    }
  }
}

/**
 * R5.3 — closes the loop on nudges delivered in a previous pass.
 *
 * Costs ONE batched Redis read for the whole scan set and reuses the snapshots
 * the pass already computed: no extra Mongo query, no per-Room round trip.
 * A Room is only reported once — the marker is deleted the moment a verdict is
 * reached, so a revived Room cannot be counted again on the next pass.
 *
 * Always resolves; a measurement failure never affects engagement.
 */
async function measureRevivals(rooms, snapshotByRoom, now, summary) {
  try {
    const ids = rooms.map(r => String(r._id));
    const markers = await safeGetMany(ids.map(outcomeKey));
    if (markers.size === 0) return;

    for (const roomId of ids) {
      const marker = markers.get(outcomeKey(roomId));
      if (!marker) continue;

      const snapshot = snapshotByRoom.get(roomId);
      const outcome = classifyRevival(marker, snapshot, now);
      // PENDING means "too early to tell" or "window expired" — say nothing and
      // let the marker's own TTL decide when to stop watching.
      if (outcome === OUTCOME.PENDING || outcome === OUTCOME.NO_ACTIVITY) continue;

      emitEngagementEvent(
        outcome === OUTCOME.REVIVED ? 'room_reengagement_success' : 'room_reengagement_outcome',
        {
          roomId,
          action: marker.action,
          outcome,
          engagementState: snapshot ? snapshot.state : null,
          participantsAtSend: marker.participantsAtSend,
          participantsNow: snapshot ? snapshot.participatingMemberCount : null,
          targetsNotified: marker.targetsNotified,
          hoursSinceSend: Math.round(((now - marker.sentAt) / 3600000) * 10) / 10,
        }
      );

      if (outcome === OUTCOME.REVIVED) summary.roomsRevived++;
      else summary.roomsActiveNotRevived++;

      // Verdict reached — stop watching this Room so it is never double-counted.
      try { await redisService.del(outcomeKey(roomId)); } catch (_) { /* TTL clears it */ }
    }
  } catch (err) {
    console.error('[ROOM_ENGAGEMENT] revival measurement failed:', err.message);
  }
}

/**
 * Members, last senders and users for the acting set — three queries total,
 * regardless of how many Rooms are being acted on.
 */
async function loadActionContext(roomIds) {
  const membersByRoom = new Map();
  const lastSenderByRoom = new Map();
  const usersById = new Map();
  if (!roomIds || roomIds.length === 0) return { membersByRoom, lastSenderByRoom, usersById };

  const members = await RoomMember.find({ roomId: { $in: roomIds }, status: 'JOINED' })
    .select('roomId userId').lean();
  members.forEach(m => {
    const key = String(m.roomId);
    if (!membersByRoom.has(key)) membersByRoom.set(key, []);
    membersByRoom.get(key).push({ userId: m.userId });
  });

  // Latest sender per Room — one aggregation, served by { roomId, createdAt: -1 }.
  const lastSenders = await RoomMessage.aggregate([
    { $match: { roomId: { $in: roomIds }, messageType: 'TEXT' } },
    { $sort: { roomId: 1, createdAt: -1 } },
    { $group: { _id: '$roomId', senderId: { $first: '$senderId' } } },
  ]);
  lastSenders.forEach(r => lastSenderByRoom.set(String(r._id), String(r.senderId)));

  const allUserIds = [...new Set(members.map(m => String(m.userId)))];
  if (allUserIds.length > 0) {
    const users = await User.find({ _id: { $in: allUserIds } })
      .select('_id status suspensionInfo pushNotifications fcmDevices').lean();
    users.forEach(u => usersById.set(String(u._id), u));
  }

  return { membersByRoom, lastSenderByRoom, usersById };
}

/** True only when a real Redis client is configured (the in-process map is not one). */
function redisAvailable() {
  try {
    return Boolean(redisService.getClient && redisService.getClient());
  } catch (_) {
    return false;
  }
}

async function safeGetMany(keys) {
  try {
    return await redisService.getMany(keys);
  } catch (err) {
    // Fail closed: an unreadable cooldown/state map means we must not act.
    console.error('[ROOM_ENGAGEMENT] batch redis read failed:', err.message);
    return new Map();
  }
}

/** Ids, counts and reasons only. Never message text, names, tokens or profile data. */
function logPass(summary) {
  if (summary.actionsExecuted > 0 || summary.stateTransitions > 0 || summary.roomsFailed > 0 ||
      summary.roomsRevived > 0 || summary.roomsActiveNotRevived > 0 || summary.error) {
    console.log('[ROOM_ENGAGEMENT]', JSON.stringify(summary));
  }
}

module.exports = {
  ENGAGEMENT_CONFIG,
  ACTION,
  REASON,
  OUTCOME,
  classifyRevival,
  measureRevivals,
  emitEngagementEvent,
  outcomeKey,
  ENGAGEABLE_LIFECYCLE_STATUSES,
  WORKER_LOCK_KEY,
  decideRoomAction,
  buildReengagementCopy,
  userSkipReason,
  capableTokens,
  findEvaluableRooms,
  executeReengagement,
  runEngagementPass,
  loadActionContext,
  redisAvailable,
  roomCooldownKey,
  roomClaimKey,
  userCooldownKey,
  userDailyKey,
};
