// services/meetup/meetupEligibilityService.js
// -----------------------------------------------------------------------------
// R7.1 — "may this user propose a Meetup in this Room right now?" (spec §5-§8, §13, §14)
//
// EVERY answer is derived from server state. Nothing a client sends is consulted:
// not Room age, not member count, not membership, not engagement, not eligibility.
// The request body is not read by this module at all.
//
// It does not duplicate R5: Room engagement comes from
// roomEngagementService.evaluateRoom(), and the "which lifecycle statuses cannot
// hold a conversation" rule is imported from R5's NON_CONVERSATIONAL_STATUSES
// rather than restated. There is one engagement algorithm in this codebase.
//
// It does not duplicate the safety system: blocking reuses User.blockedUsers with
// the same bidirectional pair-check and the same deliberately generic response as
// roomController.joinRoom. No second block store, no second block semantic.
//
// FAILS CLOSED. Anything missing, ambiguous or unreadable produces "not eligible".
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../../models/HumrahRoom');
const RoomMember = require('../../models/RoomMember');
const User = require('../../models/User');

const { MEETUP_CONFIG, minRoomAgeMs } = require('./meetupConfig');
const { MEETUP_ERROR, MEETUP_EVENT, emitMeetupEvent } = require('./meetupTelemetry');
const { ACTIVE_STATUSES } = require('./meetupStateMachine');
const { expireStaleMeetupsForRoom } = require('./meetupExpiryService');
const { evaluateRoom, NON_CONVERSATIONAL_STATUSES } = require('../roomEngagementService');

/** Uniform negative result. `code` is the API contract; `message` is user-facing. */
const deny = (code, message, details = {}) => ({ eligible: false, code, message, ...details });

/**
 * Room age, in whole-millisecond server time (spec §5).
 *
 * MANDATORY RULE: currentServerTime - room.createdAt >= MIN_ROOM_AGE_HOURS.
 * The comparison is >=, so a Room created at 10:00 becomes eligible at exactly
 * 10:00 the next day, and is rejected at 09:59:59.999.
 *
 * Pure and exported so the boundary can be tested to the millisecond without a
 * database, and so no caller re-derives it.
 */
function isRoomOldEnough(roomCreatedAt, now = Date.now(), minAgeMs = minRoomAgeMs()) {
  if (!roomCreatedAt) return false;
  const created = new Date(roomCreatedAt).getTime();
  if (!Number.isFinite(created)) return false;
  return (now - created) >= minAgeMs;
}

/** Room age in hours, for telemetry only. */
function roomAgeHours(roomCreatedAt, now = Date.now()) {
  const created = new Date(roomCreatedAt).getTime();
  if (!Number.isFinite(created)) return null;
  return Math.round(((now - created) / (60 * 60 * 1000)) * 10) / 10;
}

/**
 * Bidirectional block check between the proposer and the other JOINED members.
 *
 * Same rule and same generic message as joinRoom: the response never reveals which
 * user is involved, or that a block exists at all.
 */
async function hasBlockRelationship(proposer, memberIds) {
  const counterpartIds = new Set(memberIds.map(String));
  counterpartIds.delete(String(proposer._id));
  if (counterpartIds.size === 0) return false;

  const iBlockedThem = (proposer.blockedUsers || []).some(b => counterpartIds.has(String(b)));
  if (iBlockedThem) return true;

  return Boolean(await User.exists({
    _id: { $in: Array.from(counterpartIds) },
    blockedUsers: proposer._id,
  }));
}

/**
 * The complete eligibility evaluation.
 *
 * Ordered cheapest-and-most-specific first, so a caller gets the most actionable
 * error, and so expensive checks (engagement evaluation, block lookup) only run for
 * requests that have already earned them.
 *
 * @returns {Promise<object>} { eligible: true, room, memberIds, participantSnapshot,
 *                              engagementState, memberCount, roomAgeHours }
 *                            or { eligible: false, code, message, ... }
 */
async function evaluateMeetupEligibility({ roomId, userId, now = Date.now() }) {
  const nowDate = new Date(now);

  // ── 1. Room exists ────────────────────────────────────────────────────────
  const room = await HumrahRoom.findById(roomId)
    .select('_id status createdBy createdAt capacity memberCount creationSource')
    .lean();
  if (!room) {
    return deny(MEETUP_ERROR.ROOM_NOT_FOUND, 'Room not found');
  }

  // ── 2. The proposer is CURRENTLY a member ─────────────────────────────────
  // Live membership, re-read on every request. A LEFT or KICKED row is not a
  // membership, so a removed member is rejected here.
  const membership = await RoomMember.findOne({ roomId: room._id, userId })
    .select('status joinedAt').lean();
  if (!membership || membership.status !== 'JOINED') {
    return deny(MEETUP_ERROR.NOT_ROOM_MEMBER, 'You are not a member of this Room');
  }

  // ── 3. Room lifecycle ─────────────────────────────────────────────────────
  // Reuses R5's definition rather than restating it: CLOSED / INACTIVE /
  // SUGGESTED cannot hold a conversation, so they cannot host a Meetup.
  // ACTIVE and FULL both can — FULL simply means the Room reached capacity.
  if (NON_CONVERSATIONAL_STATUSES.has(room.status)) {
    return deny(MEETUP_ERROR.ROOM_NOT_ELIGIBLE, 'This Room cannot host a Meetup right now', {
      lifecycleStatus: room.status,
    });
  }

  // ── 4. MANDATORY 24-hour Room age (spec §5) ───────────────────────────────
  if (!isRoomOldEnough(room.createdAt, now)) {
    emitMeetupEvent(MEETUP_EVENT.ROOM_TOO_YOUNG, {
      roomId: String(room._id), userId: String(userId),
      roomAgeHours: roomAgeHours(room.createdAt, now),
    });
    return deny(
      MEETUP_ERROR.ROOM_TOO_YOUNG,
      `A Room must be at least ${MEETUP_CONFIG.MIN_ROOM_AGE_HOURS} hours old before planning a Meetup`,
      { roomAgeHours: roomAgeHours(room.createdAt, now) }
    );
  }

  // ── 5. Minimum eligible HUMAN members (spec §7) ───────────────────────────
  // Counted from RoomMember rows with status JOINED. This is authoritative; the
  // denormalized HumrahRoom.memberCount is never used for a gate.
  //
  // THE AI HOST CANNOT BE COUNTED HERE. R6 gives the AI Host no user account and
  // no RoomMember row at all — it is not a member, so there is no row for this
  // query to return. Its messages are also invisible to the participation maths
  // below, because R5's aggregation filters messageType:'TEXT' and AI messages are
  // persisted as messageType:'AI_HOST'.
  const joinedMembers = await RoomMember.find({ roomId: room._id, status: 'JOINED' })
    .select('userId joinedAt').lean();
  const memberIds = joinedMembers.map(m => String(m.userId));

  if (memberIds.length < MEETUP_CONFIG.MIN_ELIGIBLE_MEMBERS) {
    emitMeetupEvent(MEETUP_EVENT.INSUFFICIENT_MEMBERS, {
      roomId: String(room._id), userId: String(userId), memberCount: memberIds.length,
    });
    return deny(
      MEETUP_ERROR.INSUFFICIENT_MEMBERS,
      `A Meetup needs at least ${MEETUP_CONFIG.MIN_ELIGIBLE_MEMBERS} members in the Room`,
      { memberCount: memberIds.length }
    );
  }

  // ── 6. Safety / blocking (spec §14) ───────────────────────────────────────
  // Account-level status (SUSPENDED / BANNED) is already rejected by the
  // authenticate middleware before any Room route runs; re-read here so this
  // service is safe to call from anywhere, not only behind that middleware.
  const proposer = await User.findById(userId).select('_id status blockedUsers').lean();
  if (!proposer || proposer.status !== 'ACTIVE') {
    return deny(MEETUP_ERROR.MEETUP_NOT_ALLOWED, "You can't plan a Meetup right now");
  }
  if (await hasBlockRelationship(proposer, memberIds)) {
    // Deliberately identical to the account-ineligible message above: the caller
    // cannot distinguish "I am blocked" from "my account is restricted", and no
    // block relationship is ever disclosed.
    return deny(MEETUP_ERROR.MEETUP_NOT_ALLOWED, "You can't plan a Meetup right now");
  }

  // ── 7. R5 engagement state (spec §6) ──────────────────────────────────────
  // Consumed, never recomputed. A null snapshot means R5 could not evaluate the
  // Room, which is treated as not eligible rather than as permission.
  const snapshot = await evaluateRoom(room, { now });
  const engagementState = snapshot?.state || null;
  if (!engagementState || !MEETUP_CONFIG.ELIGIBLE_ENGAGEMENT_STATES.includes(engagementState)) {
    return deny(MEETUP_ERROR.ROOM_NOT_ELIGIBLE, 'This Room is too quiet to plan a Meetup right now', {
      engagementState,
      lifecycleStatus: room.status,
    });
  }

  // ── 8. Expire this Room's overdue proposals FIRST ─────────────────────────
  // Order matters, and both checks below depend on it:
  //   - a stale proposal must not permanently occupy the Room's active slot
  //   - expiry ARMS the Room cooldown, so it has to happen before the cooldown is
  //     read. Running it afterwards would let a Room whose proposal had just
  //     expired immediately accept another one, skipping the cooldown entirely.
  const Meetup = require('../../models/Meetup');
  await expireStaleMeetupsForRoom(room._id, { now: nowDate });

  // ── 9. Room cooldown (spec §10) ───────────────────────────────────────────
  // Read from the database, not from Redis, so a cooldown survives a cache flush
  // and cannot be cleared by an outage. Always finite.
  const cooling = await Meetup.findOne({ roomId: room._id, cooldownUntil: { $gt: nowDate } })
    .select('cooldownUntil').sort({ cooldownUntil: -1 }).lean();
  if (cooling) {
    const hoursRemaining = Math.max(
      0,
      Math.round(((new Date(cooling.cooldownUntil).getTime() - now) / (60 * 60 * 1000)) * 10) / 10
    );
    emitMeetupEvent(MEETUP_EVENT.COOLDOWN_ACTIVE, {
      roomId: String(room._id), userId: String(userId), cooldownHoursRemaining: hoursRemaining,
    });
    return deny(MEETUP_ERROR.ROOM_MEETUP_COOLDOWN, 'This Room recently had a Meetup. Try again later.', {
      cooldownHoursRemaining: hoursRemaining,
    });
  }

  // ── 10. One active Meetup per Room (spec §8) ──────────────────────────────
  // This check is an early, friendly answer — it is NOT the guarantee. The unique
  // partial index on Meetup.activeRoomKey is what actually prevents two active
  // Meetups, and it is what catches the concurrent case that this read cannot.
  const existingActive = await Meetup.findOne({
    roomId: room._id,
    status: { $in: Array.from(ACTIVE_STATUSES) },
  }).select('_id status expiresAt').lean();
  if (existingActive) {
    emitMeetupEvent(MEETUP_EVENT.ACTIVE_CONFLICT, {
      roomId: String(room._id), userId: String(userId),
      meetupId: String(existingActive._id), status: existingActive.status,
    });
    return deny(MEETUP_ERROR.MEETUP_ALREADY_ACTIVE, 'This Room already has an active Meetup', {
      meetupId: String(existingActive._id),
      status: existingActive.status,
    });
  }

  // ── Eligible. Everything below is server-derived. ─────────────────────────
  return {
    eligible: true,
    room,
    memberIds,
    // Minimal snapshot (spec §3): id, membership status, joinedAt. Nothing else.
    participantSnapshot: joinedMembers.map(m => ({
      userId: m.userId,
      membershipStatus: 'JOINED',
      joinedAt: m.joinedAt || null,
    })),
    engagementState,
    lifecycleStatus: room.status,
    memberCount: memberIds.length,
    roomAgeHours: roomAgeHours(room.createdAt, now),
  };
}

module.exports = {
  evaluateMeetupEligibility,
  isRoomOldEnough,
  roomAgeHours,
  hasBlockRelationship,
};
