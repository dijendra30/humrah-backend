// services/meetup/meetupStateMachine.js
// -----------------------------------------------------------------------------
// R7.1 — the server-authoritative Meetup state machine (spec §4).
//
// The full vocabulary is declared so later phases have a stable contract, but only
// the R7.1 transitions are WIRED. A transition that does not exist in TRANSITIONS
// is impossible: transitionMeetup() derives its query filter from this table, so an
// unlisted transition matches no document and writes nothing. There is no code path
// that sets `status` directly.
//
// R7.1 deliberately does NOT implement VOTING -> SELECTED, SELECTED -> CONFIRMED,
// CONFIRMED -> COMPLETED or VOTING -> REJECTED. Those belong to R7.2/R7.3 and are
// left absent rather than stubbed, so nothing can accidentally drive a Meetup into
// a state whose behaviour has not been built.
//
// This module holds NO model require at load time — models/Meetup.js requires it,
// so the model is pulled in lazily inside the functions that need it.
// -----------------------------------------------------------------------------
'use strict';

/** The complete status vocabulary. Later phases add transitions, not states. */
const MEETUP_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED',
  VOTING: 'VOTING',
  SELECTED: 'SELECTED',
  CONFIRMED: 'CONFIRMED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
});

/**
 * A Room may hold at most ONE Meetup in these statuses (spec §8). Membership of
 * this set is what makes Meetup.activeRoomKey non-null and therefore what the
 * unique partial index constrains.
 */
const ACTIVE_STATUSES = Object.freeze(new Set([
  MEETUP_STATUS.PROPOSED,
  MEETUP_STATUS.VOTING,
  MEETUP_STATUS.SELECTED,
  MEETUP_STATUS.CONFIRMED,
]));

/** Nothing leaves these. Reaching one releases the Room's active slot. */
const TERMINAL_STATUSES = Object.freeze(new Set([
  MEETUP_STATUS.COMPLETED,
  MEETUP_STATUS.CANCELLED,
  MEETUP_STATUS.REJECTED,
  MEETUP_STATUS.EXPIRED,
]));

/**
 * Statuses that arm the Room cooldown (spec §10).
 *
 * CONFIRMED is here even though it is an ACTIVE status: once a Room has committed
 * to a Meetup, it should not immediately start proposing another. COMPLETED is
 * absent on purpose — it is only reachable from CONFIRMED, which already armed the
 * cooldown, so including it would restart the clock a second time for one Meetup.
 */
const COOLDOWN_ARMING_STATUSES = Object.freeze(new Set([
  MEETUP_STATUS.CONFIRMED,
  MEETUP_STATUS.REJECTED,
  MEETUP_STATUS.CANCELLED,
  MEETUP_STATUS.EXPIRED,
]));

/**
 * The transitions R7.1 actually implements.
 *
 * PROPOSED -> EXPIRED is included beyond the spec's minimum list because §11
 * requires that nothing sits in PROPOSED indefinitely. Without it, a proposal that
 * was never voted on would hold its Room's active slot forever.
 *
 * Everything else is an empty list: reachable as a status, but with no wired way
 * out of it yet.
 */
const TRANSITIONS = Object.freeze({
  [MEETUP_STATUS.PROPOSED]: Object.freeze([
    MEETUP_STATUS.VOTING,
    MEETUP_STATUS.CANCELLED,
    MEETUP_STATUS.EXPIRED,
  ]),
  [MEETUP_STATUS.VOTING]: Object.freeze([
    MEETUP_STATUS.CANCELLED,
    MEETUP_STATUS.EXPIRED,
  ]),
  // Not yet reachable, and with no exits until the phase that owns them lands.
  [MEETUP_STATUS.SELECTED]: Object.freeze([]),
  [MEETUP_STATUS.CONFIRMED]: Object.freeze([]),
  [MEETUP_STATUS.COMPLETED]: Object.freeze([]),
  [MEETUP_STATUS.CANCELLED]: Object.freeze([]),
  [MEETUP_STATUS.REJECTED]: Object.freeze([]),
  [MEETUP_STATUS.EXPIRED]: Object.freeze([]),
});

/** Timestamp column each status stamps, where the spec named a dedicated one. */
const STATUS_TIMESTAMP_FIELD = Object.freeze({
  [MEETUP_STATUS.VOTING]: 'votingStartedAt',
  [MEETUP_STATUS.CONFIRMED]: 'confirmedAt',
  [MEETUP_STATUS.CANCELLED]: 'cancelledAt',
  [MEETUP_STATUS.COMPLETED]: 'completedAt',
});

const isActiveStatus = (s) => ACTIVE_STATUSES.has(s);
const isTerminalStatus = (s) => TERMINAL_STATUSES.has(s);

/** Is `from -> to` a transition this phase implements? */
function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Every status that may legally reach `to`. Drives the atomic update filter. */
function statusesThatCanReach(to) {
  return Object.keys(TRANSITIONS).filter(from => canTransition(from, to));
}

/**
 * Builds the $set for a transition. Pure, so tests can assert the exact write
 * without a database.
 */
function buildTransitionUpdate(to, { now = new Date(), reason = null, cooldownMs = 0 } = {}) {
  const $set = { status: to };

  const stamp = STATUS_TIMESTAMP_FIELD[to];
  if (stamp) $set[stamp] = now;

  if (isTerminalStatus(to)) {
    $set.terminalAt = now;
    // Releasing the Room's active slot is part of the SAME atomic write as the
    // status change. There is no window in which a Room is blocked by a Meetup
    // that has already ended.
    $set.activeRoomKey = null;
    if (reason) $set['metadata.terminalReason'] = reason;
  }

  if (COOLDOWN_ARMING_STATUSES.has(to) && cooldownMs > 0) {
    $set.cooldownUntil = new Date(now.getTime() + cooldownMs);
  }

  return { $set };
}

/**
 * Applies a transition atomically.
 *
 * The filter pins BOTH the document id and the set of statuses that may legally
 * reach `to`. So:
 *   - an invalid transition matches nothing and writes nothing
 *   - two concurrent callers racing the same transition cannot both succeed —
 *     the first moves the document out of the matching set
 *
 * @returns {Promise<object|null>} the updated document, or null when the
 *          transition was invalid, the Meetup was gone, or another caller won.
 */
async function transitionMeetup(meetupId, to, { now = new Date(), reason = null, cooldownMs = 0 } = {}) {
  const Meetup = require('../../models/Meetup');

  const allowedFrom = statusesThatCanReach(to);
  if (allowedFrom.length === 0) return null; // not a transition this phase implements

  return Meetup.findOneAndUpdate(
    { _id: meetupId, status: { $in: allowedFrom } },
    buildTransitionUpdate(to, { now, reason, cooldownMs }),
    { new: true }
  );
}

module.exports = {
  MEETUP_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  COOLDOWN_ARMING_STATUSES,
  TRANSITIONS,
  STATUS_TIMESTAMP_FIELD,
  isActiveStatus,
  isTerminalStatus,
  canTransition,
  statusesThatCanReach,
  buildTransitionUpdate,
  transitionMeetup,
};
