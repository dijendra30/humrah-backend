// services/meetup/meetupConfig.js
// -----------------------------------------------------------------------------
// R7.1 — every Meetup tunable, in one place.
//
// Humrah 1.0.0 is live. This file exists so that deploying the Meetup foundation
// changes NOTHING until someone deliberately flips MEETUP_ENABLED. No controller,
// service or job may hard-code a Meetup limit, window or threshold.
//
// MEETUP_ENABLED is deliberately INDEPENDENT of ROOM_ENGAGEMENT_ENABLED and
// AI_HOST_ENABLED. Meetups consume R5 engagement state as an input, but the three
// systems are separately switchable and one being on never implies another.
//
// Follows the AI_HOST_CONFIG / ENGAGEMENT_CONFIG convention exactly (same num() /
// bool() coercion, same "safe default" posture).
// -----------------------------------------------------------------------------
'use strict';

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  return String(v).trim().toLowerCase() === 'true';
};

const MEETUP_CONFIG = {
  // ── Master switch. SAFE DEFAULT. ─────────────────────────────────────────
  // False means: the proposal endpoint rejects before touching the database,
  // no Meetup document is ever created, no telemetry is emitted, and the hourly
  // expiry sweep is a no-op. The feature is completely inert.
  ENABLED: bool(process.env.MEETUP_ENABLED, false),

  // ── Room eligibility ─────────────────────────────────────────────────────
  // MANDATORY (spec §5). A Room must have existed for this long before anyone
  // may propose a Meetup inside it. Computed from HumrahRoom.createdAt against
  // server time — the client is never consulted.
  MIN_ROOM_AGE_HOURS: num(process.env.MEETUP_MIN_ROOM_AGE_HOURS, 24),

  // Minimum JOINED *human* members. The AI Host has no RoomMember row and can
  // therefore never contribute to this count — see meetupEligibilityService.
  MIN_ELIGIBLE_MEMBERS: num(process.env.MEETUP_MIN_ELIGIBLE_MEMBERS, 2),

  // Which R5 engagement states may host a Meetup proposal. QUIET and DORMANT are
  // both excluded: a Meetup is a real-world commitment and should come out of a
  // conversation that is actually happening. Configurable because this is a
  // product judgement, not a safety invariant.
  ELIGIBLE_ENGAGEMENT_STATES: (process.env.MEETUP_ELIGIBLE_ENGAGEMENT_STATES || 'ACTIVE,HEALTHY')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),

  // ── Per-user proposal quota (rolling windows, spec §9) ───────────────────
  PROPOSAL_LIMIT_24H: num(process.env.MEETUP_PROPOSAL_LIMIT_24H, 3),
  PROPOSAL_LIMIT_7D: num(process.env.MEETUP_PROPOSAL_LIMIT_7D, 10),

  // Coarse abuse guard on *attempts* (as opposed to successful proposals, which
  // the quota above governs). Stops a caller burning cheap eligibility checks and
  // flooding the structured logs without ever reaching the quota.
  ATTEMPT_LIMIT_PER_HOUR: num(process.env.MEETUP_ATTEMPT_LIMIT_PER_HOUR, 30),

  // ── Room cooldown (spec §10) ─────────────────────────────────────────────
  // Armed when a Meetup reaches CONFIRMED / REJECTED / CANCELLED / EXPIRED, so a
  // Room cannot immediately churn out another proposal. Always finite — it can
  // never permanently block a Room.
  ROOM_COOLDOWN_HOURS: num(process.env.MEETUP_ROOM_COOLDOWN_HOURS, 24),

  // ── Proposal expiry (spec §11) ───────────────────────────────────────────
  // Every proposal carries an expiresAt. Nothing may sit in PROPOSED or VOTING
  // forever.
  PROPOSAL_EXPIRY_HOURS: num(process.env.MEETUP_PROPOSAL_EXPIRY_HOURS, 24),

  // ── Idempotency ──────────────────────────────────────────────────────────
  // Defensive cap so a client cannot store an unbounded string on the document.
  // There is deliberately no separate idempotency TTL: the authoritative record
  // is the Meetup document itself, via the unique index on
  // (proposedBy, idempotencyKey). A permanent record is strictly safer than an
  // expiring one — a retry can never duplicate, however late it arrives — and
  // costs one indexed string per Meetup.
  MAX_IDEMPOTENCY_KEY_CHARS: num(process.env.MEETUP_MAX_IDEMPOTENCY_KEY_CHARS, 128),

  // Upper bound on rows touched by one expiry sweep, so the hourly cron can never
  // turn into an unbounded write storm after a backlog.
  MAX_EXPIRY_SWEEP: num(process.env.MEETUP_MAX_EXPIRY_SWEEP, 500),
};

/** Milliseconds helpers so no caller re-derives these from the hour values. */
const HOUR_MS = 60 * 60 * 1000;
const minRoomAgeMs = () => MEETUP_CONFIG.MIN_ROOM_AGE_HOURS * HOUR_MS;
const proposalExpiryMs = () => MEETUP_CONFIG.PROPOSAL_EXPIRY_HOURS * HOUR_MS;
const roomCooldownMs = () => MEETUP_CONFIG.ROOM_COOLDOWN_HOURS * HOUR_MS;

/**
 * One startup line so an operator can see, without reading env vars, whether this
 * process can create Meetups. Mirrors the [ROOM_ENGAGEMENT] / [AI_HOST] banners.
 */
function logMeetupStartupBanner() {
  if (!MEETUP_CONFIG.ENABLED) {
    console.log('[MEETUP] Disabled (MEETUP_ENABLED != true) — no Meetup can be created by any path.');
    return;
  }
  console.log(
    `[MEETUP] Enabled — min Room age ${MEETUP_CONFIG.MIN_ROOM_AGE_HOURS}h, ` +
    `min members ${MEETUP_CONFIG.MIN_ELIGIBLE_MEMBERS}, ` +
    `quota ${MEETUP_CONFIG.PROPOSAL_LIMIT_24H}/24h + ${MEETUP_CONFIG.PROPOSAL_LIMIT_7D}/7d, ` +
    `Room cooldown ${MEETUP_CONFIG.ROOM_COOLDOWN_HOURS}h, ` +
    `proposal expiry ${MEETUP_CONFIG.PROPOSAL_EXPIRY_HOURS}h, ` +
    `engagement states [${MEETUP_CONFIG.ELIGIBLE_ENGAGEMENT_STATES.join('|')}].`
  );
}

module.exports = {
  MEETUP_CONFIG,
  HOUR_MS,
  minRoomAgeMs,
  proposalExpiryMs,
  roomCooldownMs,
  logMeetupStartupBanner,
};
