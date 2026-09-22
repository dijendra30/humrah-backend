// services/meetup/meetupProposalService.js
// -----------------------------------------------------------------------------
// R7.1 — creating a Meetup proposal. The only path that writes a new Meetup.
//
// CONCURRENCY STRATEGY (spec §8, §12) — deliberately database-enforced, with no
// Redis lock anywhere in this file:
//
//   Two unique PARTIAL indexes on the Meetup collection are the guarantees:
//     { activeRoomKey }                 -> one active Meetup per Room
//     { proposedBy, idempotencyKey }    -> one Meetup per user per key
//
//   Both are evaluated by MongoDB during the insert itself, so there is no window
//   between "check" and "create" for a second request to slip through. The
//   eligibility read of the same rules earlier in the flow exists only to return a
//   friendly, specific error in the common case; it is explicitly NOT the
//   guarantee, and losing that read's race is handled below by catching E11000.
//
//   A Redis advisory lock was considered and rejected: it is strictly weaker than
//   the index (it cannot bind the write), it adds a false-rejection mode when a
//   holder dies mid-request, and it would make correctness depend on Redis being
//   up. Redis is used in this phase only where it is genuinely the right tool —
//   the rolling proposal quota — and there it fails closed.
//
// FEATURE FLAG: nothing below runs while MEETUP_ENABLED is false. The check is the
// first statement, before any database read.
// -----------------------------------------------------------------------------
'use strict';

const Meetup = require('../../models/Meetup');
const { MEETUP_CONFIG, proposalExpiryMs } = require('./meetupConfig');
const { MEETUP_ERROR, MEETUP_EVENT, emitMeetupEvent } = require('./meetupTelemetry');
const { MEETUP_STATUS } = require('./meetupStateMachine');
const { evaluateMeetupEligibility } = require('./meetupEligibilityService');
const {
  consumeProposalSlot,
  refundProposalSlot,
  registerAttempt,
} = require('./meetupRateLimitService');

const fail = (code, message, details = {}) => ({ ok: false, code, message, ...details });

/**
 * The server-authoritative wire representation (spec §18).
 *
 * Only these fields leave the server. Notably absent: participantSnapshot (it is
 * an internal integrity record, not client data) and metadata.
 */
function serializeMeetup(meetup) {
  if (!meetup) return null;
  return {
    id: String(meetup._id),
    roomId: String(meetup.roomId),
    proposedBy: String(meetup.proposedBy),
    status: meetup.status,
    createdAt: meetup.createdAt ? new Date(meetup.createdAt).toISOString() : null,
    expiresAt: meetup.expiresAt ? new Date(meetup.expiresAt).toISOString() : null,
  };
}

/**
 * Normalises a client-supplied Idempotency-Key.
 * Returns null for anything absent, blank or non-string, so an unusable key is
 * simply treated as "no key" rather than rejected.
 */
function normalizeIdempotencyKey(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MEETUP_CONFIG.MAX_IDEMPOTENCY_KEY_CHARS);
}

/** Which unique index a duplicate-key error came from. */
function duplicateKeyField(err) {
  if (!err || err.code !== 11000) return null;
  const keys = Object.keys(err.keyPattern || err.keyValue || {});
  if (keys.includes('activeRoomKey')) return 'activeRoomKey';
  if (keys.includes('idempotencyKey')) return 'idempotencyKey';
  return 'unknown';
}

/**
 * Creates one Meetup proposal.
 *
 * @param {object}  args
 * @param {string}  args.roomId          from the URL, already shape-validated
 * @param {string}  args.userId          from the JWT — never from the body
 * @param {?string} args.idempotencyKey  from the Idempotency-Key header
 * @returns {Promise<{ok:true, meetup:object, replayed:boolean} | {ok:false, code:string, message:string}>}
 */
async function createMeetupProposal({ roomId, userId, idempotencyKey = null, now = Date.now() }) {
  // ── 0. Feature flag (spec §23). Before any database access. ───────────────
  if (!MEETUP_CONFIG.ENABLED) {
    return fail(MEETUP_ERROR.MEETUP_NOT_ALLOWED, 'Meetups are not available right now');
  }

  const key = normalizeIdempotencyKey(idempotencyKey);
  const nowDate = new Date(now);

  emitMeetupEvent(MEETUP_EVENT.PROPOSAL_ATTEMPTED, {
    roomId: String(roomId), userId: String(userId), idempotent: Boolean(key),
  });

  // ── 1. Coarse attempt guard. Fails OPEN — it is anti-noise, not a control. ──
  const attempt = await registerAttempt(userId);
  if (!attempt.allowed) {
    emitMeetupEvent(MEETUP_EVENT.RATE_LIMITED, {
      userId: String(userId), roomId: String(roomId), window: 'attempts_1h',
      limit: MEETUP_CONFIG.ATTEMPT_LIMIT_PER_HOUR,
    });
    return fail(MEETUP_ERROR.MEETUP_RATE_LIMITED, 'Too many Meetup requests. Please try again later.');
  }

  // ── 2. Idempotency replay, BEFORE eligibility ─────────────────────────────
  // A retry of a request that already succeeded must return the original Meetup
  // even if the Room would no longer accept a new proposal — which is exactly the
  // situation a successful first attempt creates.
  if (key) {
    const existing = await Meetup.findOne({ proposedBy: userId, idempotencyKey: key }).lean();
    if (existing) {
      emitMeetupEvent(MEETUP_EVENT.PROPOSAL_REPLAYED, {
        roomId: String(existing.roomId), userId: String(userId),
        meetupId: String(existing._id), status: existing.status, replayed: true,
      });
      return { ok: true, meetup: serializeMeetup(existing), replayed: true };
    }
  }

  // ── 3. Eligibility. Every rule, all server-derived. ───────────────────────
  const eligibility = await evaluateMeetupEligibility({ roomId, userId, now });
  if (!eligibility.eligible) {
    emitMeetupEvent(MEETUP_EVENT.PROPOSAL_REJECTED, {
      roomId: String(roomId), userId: String(userId), code: eligibility.code,
      engagementState: eligibility.engagementState,
      lifecycleStatus: eligibility.lifecycleStatus,
      memberCount: eligibility.memberCount,
      roomAgeHours: eligibility.roomAgeHours,
      cooldownHoursRemaining: eligibility.cooldownHoursRemaining,
    });
    // Forward the actionable detail the eligibility rules produced. Without this
    // the controller's optional fields could never be populated, and a client
    // could not tell a caller how young the Room is or how long to wait.
    return fail(eligibility.code, eligibility.message, {
      meetupId: eligibility.meetupId,
      status: eligibility.status,
      memberCount: eligibility.memberCount,
      roomAgeHours: eligibility.roomAgeHours,
      cooldownHoursRemaining: eligibility.cooldownHoursRemaining,
    });
  }

  // ── 4. Quota. Consumed LAST, so only a request that would otherwise succeed
  //      spends one of the user's three daily slots. Fails CLOSED on Redis loss. ──
  const quota = await consumeProposalSlot(userId, { now });
  if (!quota.allowed) {
    emitMeetupEvent(MEETUP_EVENT.PROPOSAL_REJECTED, {
      roomId: String(roomId), userId: String(userId),
      code: MEETUP_ERROR.MEETUP_RATE_LIMITED, reason: quota.reason,
      proposalsLast24h: quota.proposalsLast24h, proposalsLast7d: quota.proposalsLast7d,
    });
    const message = quota.reason === 'redis_unavailable' || quota.reason === 'redis_error'
      ? 'Meetup planning is temporarily unavailable. Please try again shortly.'
      : 'You have reached your Meetup proposal limit. Please try again later.';
    return fail(MEETUP_ERROR.MEETUP_RATE_LIMITED, message, {
      proposalsLast24h: quota.proposalsLast24h,
      proposalsLast7d: quota.proposalsLast7d,
      window: quota.window,
    });
  }

  // ── 5. Create. The database has the final say. ────────────────────────────
  try {
    const meetup = await Meetup.create({
      roomId: eligibility.room._id,
      proposedBy: userId,
      status: MEETUP_STATUS.PROPOSED,
      // Set explicitly as well as by the pre-save hook, so the guarantee is
      // visible at the call site and not only in the schema.
      activeRoomKey: eligibility.room._id,
      idempotencyKey: key,
      expiresAt: new Date(now + proposalExpiryMs()),
      participantSnapshot: eligibility.participantSnapshot,
      metadata: {
        proposalSource: 'USER_REQUEST',
        engagementStateAtProposal: eligibility.engagementState,
        roomLifecycleStatusAtProposal: eligibility.lifecycleStatus,
        memberCountAtProposal: eligibility.memberCount,
        roomAgeHoursAtProposal: eligibility.roomAgeHours,
      },
    });

    emitMeetupEvent(MEETUP_EVENT.PROPOSAL_CREATED, {
      roomId: String(meetup.roomId), userId: String(userId), meetupId: String(meetup._id),
      status: meetup.status,
      engagementState: eligibility.engagementState,
      memberCount: eligibility.memberCount,
      participantCount: eligibility.participantSnapshot.length,
      roomAgeHours: eligibility.roomAgeHours,
      expiresInHours: MEETUP_CONFIG.PROPOSAL_EXPIRY_HOURS,
      proposalsLast24h: quota.proposalsLast24h,
      proposalsLast7d: quota.proposalsLast7d,
      idempotent: Boolean(key),
    });

    return { ok: true, meetup: serializeMeetup(meetup), replayed: false };

  } catch (err) {
    const duplicated = duplicateKeyField(err);

    // The slot was consumed for a Meetup that does not exist. Hand it back so a
    // lost race never costs the user part of their daily quota.
    await refundProposalSlot(userId, quota.receipt);

    if (duplicated) {
      // A concurrent request with the SAME key can violate both unique indexes at
      // once, and MongoDB reports only one of them — which one is not guaranteed.
      // So whenever a key was supplied, look for that key's winner FIRST, before
      // trusting the reported keyPattern. Getting this backwards would answer a
      // legitimate retry with MEETUP_ALREADY_ACTIVE whenever the activeRoomKey
      // index happened to be evaluated first.
      if (key) {
        const winner = await Meetup.findOne({ proposedBy: userId, idempotencyKey: key }).lean();
        if (winner) {
          emitMeetupEvent(MEETUP_EVENT.PROPOSAL_REPLAYED, {
            roomId: String(winner.roomId), userId: String(userId),
            meetupId: String(winner._id), status: winner.status, replayed: true,
            reason: 'concurrent_same_key',
          });
          return { ok: true, meetup: serializeMeetup(winner), replayed: true };
        }
      }

      // No key, or no winner under it: another request created this Room's active
      // Meetup between our eligibility read and our insert. This is exactly the
      // concurrent case the activeRoomKey index exists to catch.
      emitMeetupEvent(MEETUP_EVENT.ACTIVE_CONFLICT, {
        roomId: String(roomId), userId: String(userId),
        reason: 'unique_index', code: duplicated,
      });
      return fail(MEETUP_ERROR.MEETUP_ALREADY_ACTIVE, 'This Room already has an active Meetup');
    }

    console.error('[MEETUP] proposal create failed:', err.message);
    emitMeetupEvent(MEETUP_EVENT.PROPOSAL_REJECTED, {
      roomId: String(roomId), userId: String(userId),
      code: MEETUP_ERROR.MEETUP_NOT_ALLOWED, reason: 'create_failed',
    });
    return fail(MEETUP_ERROR.MEETUP_NOT_ALLOWED, 'Could not create the Meetup. Please try again.');
  }
}

module.exports = {
  createMeetupProposal,
  serializeMeetup,
  normalizeIdempotencyKey,
  duplicateKeyField,
};
