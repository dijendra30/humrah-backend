// services/roomEngagementService.js
// -----------------------------------------------------------------------------
// R5.1 — canonical Room engagement evaluation. ONE backend source of truth.
//
// Engagement is DERIVED, never stored. Every input already exists:
//   HumrahRoom.status / createdAt / lastMessageAt / memberCount   (R1 denormalized)
//   RoomMessage.createdAt + senderId    (served by the {roomId,createdAt:-1} index)
//   roomPresenceService.getUsersInsideRoom()  (ephemeral socket/Redis presence)
//
// Nothing here writes to MongoDB, sends a notification, changes Room lifecycle,
// membership, capacity or discovery. It answers one question: "what condition is
// this Room's conversation in right now?"
//
// ENGAGEMENT STATE IS NOT ROOM LIFECYCLE STATUS.
//   lifecycle  = SUGGESTED / ACTIVE / FULL / INACTIVE / CLOSED   (HumrahRoom.status)
//   engagement = ACTIVE / HEALTHY / QUIET / DORMANT              (derived, here)
// A Room can be lifecycle-ACTIVE but engagement-DORMANT. They never overwrite
// each other.
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMessage = require('../models/RoomMessage');
const redisService = require('./redisService');
const { getUsersInsideRoom } = require('./roomPresenceService');

const STATE = {
  ACTIVE: 'ACTIVE',     // a conversation is happening right now
  HEALTHY: 'HEALTHY',   // a real multi-person conversation, recently
  QUIET: 'QUIET',       // has messages, but the conversation has stalled
  DORMANT: 'DORMANT',   // no conversation to speak of
};

/**
 * Thresholds. Deliberately nested INSIDE the existing Room lifecycle windows so
 * engagement can never contradict the expiry job (humrahRoomExpiryJob.js):
 *   SUGGESTED -> CLOSED   @  2h
 *   ACTIVE    -> INACTIVE @ 24h with no message
 *   INACTIVE  -> CLOSED   @ 48h
 *
 * ACTIVE_WINDOW  (15m) — "right now": a live back-and-forth.
 * HEALTHY_WINDOW  (6h) — same session/evening; still a warm conversation.
 * QUIET_WINDOW   (24h) — matches the lifecycle inactivity boundary exactly, so a
 *                        Room becomes DORMANT at the same moment the expiry job
 *                        would consider it inactive. No disagreement is possible.
 * PARTICIPATION_WINDOW (24h) — how far back we look for distinct contributors.
 */
const THRESHOLDS = {
  ACTIVE_WINDOW_MS: 15 * 60 * 1000,
  HEALTHY_WINDOW_MS: 6 * 60 * 60 * 1000,
  QUIET_WINDOW_MS: 24 * 60 * 60 * 1000,
  PARTICIPATION_WINDOW_MS: 24 * 60 * 60 * 1000,
  MIN_PARTICIPANTS_FOR_CONVERSATION: 2, // one person talking to themselves is not a conversation
  CACHE_TTL_SECONDS: 60,
};

/** Lifecycle states in which a Room can have no live conversation, by definition. */
const NON_CONVERSATIONAL_STATUSES = new Set(['CLOSED', 'INACTIVE', 'SUGGESTED']);

const cacheKey = (roomId) => `room_engagement:${roomId}`;

/**
 * Recent-message signals for a set of Rooms — ONE aggregation for all of them.
 * Uses the existing { roomId: 1, createdAt: -1 } index; never loads message bodies.
 *
 * @returns {Map<string, {recentMessageCount:number, participants:Set<string>, lastMessageAt:Date|null}>}
 */
async function loadRecentActivity(roomIds, now) {
  const since = new Date(now - THRESHOLDS.PARTICIPATION_WINDOW_MS);
  const rows = await RoomMessage.aggregate([
    { $match: { roomId: { $in: roomIds }, messageType: 'TEXT', createdAt: { $gte: since } } },
    { $group: { _id: { roomId: '$roomId', senderId: '$senderId' }, n: { $sum: 1 }, last: { $max: '$createdAt' } } },
    { $group: {
        _id: '$_id.roomId',
        senders: { $addToSet: '$_id.senderId' },
        recentMessageCount: { $sum: '$n' },
        lastMessageAt: { $max: '$last' },
    } },
  ]);

  const byRoom = new Map();
  rows.forEach(r => {
    byRoom.set(String(r._id), {
      recentMessageCount: r.recentMessageCount || 0,
      participants: new Set((r.senders || []).map(String)),
      lastMessageAt: r.lastMessageAt || null,
    });
  });
  return byRoom;
}

/**
 * Pure state rule. Deterministic, side-effect free, cheap, no AI.
 * Exported so tests can drive it directly without a database.
 */
function classify({ status, memberCount, lastActivityAt, recentMessageCount, participatingMemberCount, now }) {
  const reasons = [];

  // 1. Lifecycle gate. A CLOSED / INACTIVE / SUGGESTED Room is never "engaged",
  //    no matter how much history it has. This is what stops an old Room with
  //    stale messages from being reported as ACTIVE.
  if (NON_CONVERSATIONAL_STATUSES.has(status)) {
    return { state: STATE.DORMANT, reasons: [`lifecycle_${String(status).toLowerCase()}`] };
  }

  // 2. No conversation is possible below two members.
  if ((memberCount || 0) < THRESHOLDS.MIN_PARTICIPANTS_FOR_CONVERSATION) {
    return { state: STATE.DORMANT, reasons: ['insufficient_members'] };
  }

  // 3. Never had a message.
  if (!lastActivityAt) {
    return { state: STATE.DORMANT, reasons: ['no_messages'] };
  }

  const sinceLast = now - new Date(lastActivityAt).getTime();
  const multiParty = participatingMemberCount >= THRESHOLDS.MIN_PARTICIPANTS_FOR_CONVERSATION;

  if (sinceLast >= THRESHOLDS.QUIET_WINDOW_MS) {
    return { state: STATE.DORMANT, reasons: ['no_activity_24h'] };
  }

  // 4. A single member talking alone is QUIET at best, regardless of recency —
  //    volume from one person is not engagement.
  if (!multiParty) {
    reasons.push('single_participant');
    return { state: STATE.QUIET, reasons };
  }

  if (sinceLast <= THRESHOLDS.ACTIVE_WINDOW_MS) {
    reasons.push('live_conversation', 'multi_participant');
    return { state: STATE.ACTIVE, reasons };
  }

  if (sinceLast <= THRESHOLDS.HEALTHY_WINDOW_MS) {
    reasons.push('recent_conversation', 'multi_participant');
    return { state: STATE.HEALTHY, reasons };
  }

  reasons.push('stalled_conversation');
  return { state: STATE.QUIET, reasons };
}

/**
 * Builds the engagement snapshot for one Room.
 *
 * @param {object}  room  HumrahRoom doc (lean ok) — pass it in if you already have it
 * @param {object}  opts  { io, now, activity } — `io` enables live presence counting
 * @returns {Promise<object>} snapshot
 */
async function buildSnapshot(room, opts = {}) {
  const now = opts.now || Date.now();
  const roomId = String(room._id);

  const activity = opts.activity || (await loadRecentActivity([room._id], now)).get(roomId) || {
    recentMessageCount: 0, participants: new Set(), lastMessageAt: null,
  };

  // room.lastMessageAt is authoritative for "when did anything last happen";
  // the aggregation's max is only within the 24h window.
  const lastActivityAt = room.lastMessageAt || activity.lastMessageAt || null;
  const memberCount = typeof room.memberCount === 'number' ? room.memberCount : 0;
  const participatingMemberCount = activity.participants.size;

  const { state, reasons } = classify({
    status: room.status,
    memberCount,
    lastActivityAt,
    recentMessageCount: activity.recentMessageCount,
    participatingMemberCount,
    now,
  });

  // Live presence is ephemeral and optional — never persisted, never required.
  let activeMemberCount = null;
  if (opts.io) {
    try {
      const inside = await getUsersInsideRoom(opts.io, roomId, opts.candidateUserIds || []);
      activeMemberCount = inside.size;
    } catch (err) {
      console.error('[ROOM_ENGAGEMENT] presence read failed:', err.message);
    }
  }

  return {
    roomId,
    state,
    reasons,
    lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
    recentMessageCount: activity.recentMessageCount,
    participatingMemberCount,
    memberCount,
    activeMemberCount,          // null when presence was not requested/available
    evaluatedAt: new Date(now).toISOString(),
  };
}

/**
 * Canonical single-Room evaluation. Short-lived Redis cache because
 * getRoomDetails is hit on every chat open and every socket rejoin.
 * Redis being unavailable only costs one aggregation — never an error.
 */
async function evaluateRoom(roomIdOrDoc, opts = {}) {
  try {
    const isDoc = roomIdOrDoc && typeof roomIdOrDoc === 'object' && roomIdOrDoc._id;
    const roomId = String(isDoc ? roomIdOrDoc._id : roomIdOrDoc);

    if (!opts.skipCache) {
      try {
        const cached = await redisService.get(cacheKey(roomId));
        if (cached && cached.state) return cached;
      } catch (_) { /* cache miss is not an error */ }
    }

    const room = isDoc ? roomIdOrDoc : await HumrahRoom.findById(roomId).lean();
    if (!room) return null;

    const snapshot = await buildSnapshot(room, opts);

    try {
      await redisService.set(cacheKey(roomId), snapshot, THRESHOLDS.CACHE_TTL_SECONDS);
    } catch (_) { /* caching is best-effort */ }

    return snapshot;
  } catch (err) {
    // Engagement is advisory. It must never break a Room read.
    console.error('[ROOM_ENGAGEMENT] evaluateRoom failed:', err.message);
    return null;
  }
}

/**
 * Batch evaluation — R5.2 will sweep many Rooms, so the foundation must not be
 * N+1. Total cost: 1 aggregation for ALL Rooms, regardless of count.
 */
async function evaluateRooms(rooms, opts = {}) {
  const now = opts.now || Date.now();
  const list = (rooms || []).filter(Boolean);
  if (list.length === 0) return [];

  const activityByRoom = await loadRecentActivity(list.map(r => r._id), now);
  const out = [];
  for (const room of list) {
    const activity = activityByRoom.get(String(room._id)) || {
      recentMessageCount: 0, participants: new Set(), lastMessageAt: null,
    };
    out.push(await buildSnapshot(room, { ...opts, now, activity }));
  }
  return out;
}

/**
 * Emits a log line ONLY when a Room's engagement state actually changes.
 * Prevents log flooding from repeated evaluation. Counts and ids only — never
 * message content, user identities or profile data.
 *
 * R5.2 will hang behaviour off this transition point; R5.1 only observes it.
 */
async function recordStateTransition(snapshot) {
  if (!snapshot || !snapshot.roomId) return null;
  const key = `room_engagement_state:${snapshot.roomId}`;
  try {
    const previous = await redisService.get(key);
    if (previous === snapshot.state) return null;
    await redisService.set(key, snapshot.state, 7 * 24 * 3600);
    console.log('[ROOM_ENGAGEMENT]', JSON.stringify({
      event: 'room_engagement_state_changed',
      roomId: snapshot.roomId,
      from: previous || null,
      to: snapshot.state,
      reasons: snapshot.reasons,
      memberCount: snapshot.memberCount,
      participatingMemberCount: snapshot.participatingMemberCount,
      recentMessageCount: snapshot.recentMessageCount,
    }));
    return { from: previous || null, to: snapshot.state };
  } catch (err) {
    console.error('[ROOM_ENGAGEMENT] transition record failed:', err.message);
    return null;
  }
}

module.exports = {
  STATE,
  THRESHOLDS,
  NON_CONVERSATIONAL_STATUSES,
  classify,
  buildSnapshot,
  evaluateRoom,
  evaluateRooms,
  loadRecentActivity,
  recordStateTransition,
  cacheKey,
};
