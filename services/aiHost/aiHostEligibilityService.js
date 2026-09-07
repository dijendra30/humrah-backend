// services/aiHost/aiHostEligibilityService.js
// -----------------------------------------------------------------------------
// R6.1 — "could the AI Host ever be useful in this Room?"
//
// This is a FOUNDATION, not a trigger. It answers a question. It generates
// nothing, sends nothing, writes nothing, and is not wired to any job or socket.
// R6.2 decides whether to actually intervene and what to say.
//
// It CONSUMES R5 (engagement state) and does not modify it. R5 stays the single
// authority on whether a Room is ACTIVE / HEALTHY / QUIET / DORMANT; the AI Host
// never re-derives engagement, so the two can never disagree.
//
//   R5 engagement state  ->  [ this file ]  ->  R6.2 decision  ->  generation
//                                                                  ^ not R6.1
// -----------------------------------------------------------------------------
'use strict';

const { STATE, THRESHOLDS } = require('../roomEngagementService');
const { AI_HOST_CONFIG } = require('./aiHostConfig');

/** Every reason the foundation can give. Exactly one is returned per decision. */
const AI_HOST_REASON = {
  DISABLED: 'AI_HOST_DISABLED',
  LIFECYCLE_INELIGIBLE: 'LIFECYCLE_INELIGIBLE',
  NO_ENGAGEMENT_STATE: 'NO_ENGAGEMENT_STATE',
  ROOM_IS_ACTIVE: 'ROOM_IS_ACTIVE',
  ROOM_IS_HEALTHY: 'ROOM_IS_HEALTHY',
  ROOM_IS_DORMANT: 'ROOM_IS_DORMANT',
  MEMBERS_PRESENT: 'MEMBERS_PRESENT',
  INSUFFICIENT_MEMBERS: 'INSUFFICIENT_MEMBERS',
  INSUFFICIENT_PRIOR_CONVERSATION: 'INSUFFICIENT_PRIOR_CONVERSATION',
  RECENT_INTERVENTION: 'RECENT_INTERVENTION',
  ELIGIBLE: 'ELIGIBLE',
};

/** Lifecycle statuses in which an AI Host could ever be appropriate. */
const AI_ELIGIBLE_LIFECYCLE_STATUSES = Object.freeze(['ACTIVE', 'FULL']);

/**
 * Pure. No I/O, no clock read beyond what is passed in, no randomness.
 *
 * Ordering is cheapest-and-most-absolute first, so the master switch is checked
 * before anything is inspected at all.
 *
 * @param {object} input
 * @param {?string} input.roomId
 * @param {string}  input.lifecycleStatus     HumrahRoom.status
 * @param {?object} input.engagementSnapshot  an R5.1 snapshot, or null
 * @param {number}  input.joinedMemberCount
 * @param {number}  input.presentMemberCount  members currently inside the Room
 * @param {boolean} input.recentIntervention  did the AI Host act recently
 * @returns {{roomId:?string, eligible:boolean, reason:string, engagementState:?string}}
 */
function evaluateAiHostEligibility(input = {}) {
  const {
    roomId = null,
    lifecycleStatus,
    engagementSnapshot,
    joinedMemberCount = 0,
    presentMemberCount = 0,
    recentIntervention = false,
  } = input;

  const state = engagementSnapshot && engagementSnapshot.state ? engagementSnapshot.state : null;
  const verdict = (reason, eligible = false) => ({ roomId: roomId ? String(roomId) : null, eligible, reason, engagementState: state });

  // 1. Master switch. Nothing is inspected while the AI Host is off.
  if (!AI_HOST_CONFIG.ENABLED) return verdict(AI_HOST_REASON.DISABLED);

  // 2. Lifecycle. A retired Room is never an AI opportunity, whatever its history.
  if (!AI_ELIGIBLE_LIFECYCLE_STATUSES.includes(lifecycleStatus)) {
    return verdict(AI_HOST_REASON.LIFECYCLE_INELIGIBLE);
  }

  // 3. Fail closed on missing R5 input rather than guessing.
  if (!state) return verdict(AI_HOST_REASON.NO_ENGAGEMENT_STATE);

  // 4. A working conversation does not need an AI in it. The existence of an AI
  //    Host is not a reason to use one.
  if (state === STATE.ACTIVE) return verdict(AI_HOST_REASON.ROOM_IS_ACTIVE);
  if (state === STATE.HEALTHY) return verdict(AI_HOST_REASON.ROOM_IS_HEALTHY);

  // 5. A Room that never had a conversation is a recruitment/lifecycle problem,
  //    not something an AI comment fixes.
  if (state === STATE.DORMANT) return verdict(AI_HOST_REASON.ROOM_IS_DORMANT);

  // Only QUIET reaches here: it had a real conversation that has stalled.

  // 6. Never talk over people who are currently in the Room.
  if (presentMemberCount > 0) return verdict(AI_HOST_REASON.MEMBERS_PRESENT);

  if (joinedMemberCount < AI_HOST_CONFIG.MIN_MEMBERS) {
    return verdict(AI_HOST_REASON.INSUFFICIENT_MEMBERS);
  }

  // 7. "Meaningful prior conversation" reuses R5's definition of a conversation
  //    (>= MIN_PARTICIPANTS_FOR_CONVERSATION distinct speakers) — the AI Host
  //    does not invent a second definition of "engaged".
  const priorParticipants = engagementSnapshot.participatingMemberCount || 0;
  const required = Math.max(AI_HOST_CONFIG.MIN_PRIOR_PARTICIPANTS, THRESHOLDS.MIN_PARTICIPANTS_FOR_CONVERSATION);
  if (priorParticipants < required) {
    return verdict(AI_HOST_REASON.INSUFFICIENT_PRIOR_CONVERSATION);
  }

  // 8. Pacing. R6.2 supplies the real cooldown lookup; the gate exists now so it
  //    cannot be forgotten later.
  if (recentIntervention) return verdict(AI_HOST_REASON.RECENT_INTERVENTION);

  return verdict(AI_HOST_REASON.ELIGIBLE, true);
}

module.exports = {
  evaluateAiHostEligibility,
  AI_HOST_REASON,
  AI_ELIGIBLE_LIFECYCLE_STATUSES,
};
