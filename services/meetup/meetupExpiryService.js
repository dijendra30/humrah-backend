// services/meetup/meetupExpiryService.js
// -----------------------------------------------------------------------------
// R7.1 — proposal expiry (spec §11).
//
// A Meetup must never sit in PROPOSED or VOTING forever, because an active Meetup
// holds its Room's one active slot. Expiry has TWO mechanisms and both matter:
//
//   1. SELF-HEAL ON THE WRITE PATH — expireStaleMeetupsForRoom() runs inside the
//      proposal flow, before the one-active-Meetup check. This is what makes
//      correctness independent of any scheduler: even if every background job
//      were dead, a Room whose old proposal has expired can still take a new one.
//
//   2. HOURLY SWEEP — expireStaleMeetups() is called from the existing hourly
//      cleanup block in cronJobs.js. No new background infrastructure was created
//      for this; the project already had a reliable hourly cleanup pattern and
//      this reuses it.
//
// Both funnel through the state machine's transition rules, so expiry cannot move
// a Meetup out of a status that is not allowed to expire, and clearing
// activeRoomKey + arming the Room cooldown happen in the SAME atomic write as the
// status change.
// -----------------------------------------------------------------------------
'use strict';

const { MEETUP_CONFIG, roomCooldownMs } = require('./meetupConfig');
const { emitMeetupEvent, MEETUP_EVENT } = require('./meetupTelemetry');
const {
  MEETUP_STATUS,
  statusesThatCanReach,
  buildTransitionUpdate,
} = require('./meetupStateMachine');

/** Statuses an expiry sweep may move to EXPIRED — derived, never hard-coded. */
const EXPIRABLE_STATUSES = statusesThatCanReach(MEETUP_STATUS.EXPIRED);

/**
 * Is this Meetup logically expired right now?
 *
 * Server-authoritative and independent of whether a sweep has run yet: a caller
 * reading a Meetup document can always tell the truth about it.
 */
function isExpired(meetup, now = new Date()) {
  if (!meetup || !meetup.expiresAt) return false;
  if (!EXPIRABLE_STATUSES.includes(meetup.status)) return false;
  return new Date(meetup.expiresAt).getTime() <= now.getTime();
}

/**
 * Expires overdue Meetups matching `extraFilter`.
 * Shared by the per-Room self-heal and the global sweep.
 */
async function expireWhere(extraFilter, { now = new Date(), limit = 0 } = {}) {
  const Meetup = require('../../models/Meetup');

  const filter = {
    ...extraFilter,
    status: { $in: EXPIRABLE_STATUSES },
    expiresAt: { $lte: now },
  };

  const update = buildTransitionUpdate(MEETUP_STATUS.EXPIRED, {
    now,
    reason: 'proposal_expired',
    cooldownMs: roomCooldownMs(),
  });

  // Bounded when a limit is given, so one sweep can never become an unbounded
  // write storm after a backlog. The next run picks up the remainder.
  if (limit > 0) {
    const overdue = await Meetup.find(filter).select('_id roomId').limit(limit).lean();
    if (overdue.length === 0) return { expiredCount: 0, meetupIds: [] };
    const ids = overdue.map(m => m._id);
    // The status guard is re-asserted here, not just in the find above: a Meetup
    // that was cancelled in the gap between the two queries must not be
    // overwritten as EXPIRED.
    const res = await Meetup.updateMany(
      { _id: { $in: ids }, status: { $in: EXPIRABLE_STATUSES } },
      update
    );
    return { expiredCount: res.modifiedCount || 0, meetupIds: ids };
  }

  const res = await Meetup.updateMany(filter, update);
  return { expiredCount: res.modifiedCount || 0, meetupIds: [] };
}

/**
 * Self-heal for ONE Room, called on the proposal path. Scoped and indexed
 * ({ roomId, status, createdAt } / { status, expiresAt }), so it is cheap enough
 * to run on every proposal attempt.
 */
async function expireStaleMeetupsForRoom(roomId, { now = new Date() } = {}) {
  try {
    const { expiredCount } = await expireWhere({ roomId }, { now });
    if (expiredCount > 0) {
      emitMeetupEvent(MEETUP_EVENT.PROPOSAL_EXPIRED, {
        roomId: String(roomId), expiredCount, reason: 'self_heal',
      });
    }
    return expiredCount;
  } catch (err) {
    // Never block a proposal because the self-heal failed. The one-active-Meetup
    // check below it is still authoritative — the worst case is that a genuinely
    // expired Meetup keeps holding the slot until the hourly sweep clears it.
    console.error('[MEETUP] room expiry self-heal failed:', err.message);
    return 0;
  }
}

/**
 * Global sweep, called hourly from cronJobs.js.
 * A no-op while the feature is disabled — nothing can have been created.
 */
async function expireStaleMeetups({ now = new Date() } = {}) {
  if (!MEETUP_CONFIG.ENABLED) return { skipped: true, expiredCount: 0 };
  try {
    const { expiredCount } = await expireWhere({}, { now, limit: MEETUP_CONFIG.MAX_EXPIRY_SWEEP });
    if (expiredCount > 0) {
      emitMeetupEvent(MEETUP_EVENT.PROPOSAL_EXPIRED, { expiredCount, reason: 'scheduled_sweep' });
    }
    return { skipped: false, expiredCount };
  } catch (err) {
    console.error('[MEETUP] expiry sweep failed:', err.message);
    return { skipped: false, expiredCount: 0, error: true };
  }
}

module.exports = {
  EXPIRABLE_STATUSES,
  isExpired,
  expireStaleMeetupsForRoom,
  expireStaleMeetups,
};
