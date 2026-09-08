// services/meetup/meetupTelemetry.js
// -----------------------------------------------------------------------------
// R7.1 — the ONE place Meetup observability and error codes are defined.
//
// There is no backend PostHog in this project (no dependency, no client) and R7.1
// does not add one — the same finding R6.3 recorded. Server-side events are
// structured [MEETUP] log lines; the Android app keeps using its own PostHog. The
// two halves would join on meetupId / roomId.
//
// SAFETY BY ALLOWLIST, not by filtering — copied deliberately from
// aiHostTelemetry. Only the property names below survive. A caller that
// accidentally passes a user document, a place address or coordinates cannot leak
// them, because unknown keys are DROPPED rather than sanitised.
//
// Emission is silent while MEETUP_ENABLED is false, so a feature that is off adds
// no log noise and cannot be used to flood the logs.
// -----------------------------------------------------------------------------
'use strict';

/** Stable event names. Dashboards and greps key on these — do not rename. */
const MEETUP_EVENT = Object.freeze({
  PROPOSAL_ATTEMPTED: 'meetup_proposal_attempted',
  PROPOSAL_CREATED: 'meetup_proposal_created',
  PROPOSAL_REJECTED: 'meetup_proposal_rejected',
  PROPOSAL_REPLAYED: 'meetup_proposal_replayed',
  ROOM_TOO_YOUNG: 'meetup_room_too_young',
  INSUFFICIENT_MEMBERS: 'meetup_insufficient_members',
  RATE_LIMITED: 'meetup_proposal_rate_limited',
  ACTIVE_CONFLICT: 'meetup_active_conflict',
  COOLDOWN_ACTIVE: 'meetup_cooldown_active',
  REDIS_UNAVAILABLE: 'meetup_redis_unavailable',
  PROPOSAL_EXPIRED: 'meetup_proposal_expired',
  STATE_TRANSITION: 'meetup_state_transition',
});

/**
 * Deterministic API error codes (spec §18). The client branches on `code`; the
 * `message` is human-facing and deliberately vague where safety requires it.
 */
const MEETUP_ERROR = Object.freeze({
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  NOT_ROOM_MEMBER: 'NOT_ROOM_MEMBER',
  ROOM_TOO_YOUNG: 'ROOM_TOO_YOUNG',
  ROOM_NOT_ELIGIBLE: 'ROOM_NOT_ELIGIBLE',
  INSUFFICIENT_MEMBERS: 'INSUFFICIENT_MEMBERS',
  MEETUP_ALREADY_ACTIVE: 'MEETUP_ALREADY_ACTIVE',
  MEETUP_RATE_LIMITED: 'MEETUP_RATE_LIMITED',
  ROOM_MEETUP_COOLDOWN: 'ROOM_MEETUP_COOLDOWN',
  MEETUP_EXPIRED: 'MEETUP_EXPIRED',
  MEETUP_NOT_ALLOWED: 'MEETUP_NOT_ALLOWED',
});

/**
 * The COMPLETE set of properties a Meetup event may carry. Every entry is an id,
 * an enum, a count, a duration or a boolean.
 *
 * There is deliberately NO key here for: a place name, an address, latitude,
 * longitude, a user's name, an email, a phone number, a message body, or any free
 * text a person wrote. Those cannot be logged even by mistake.
 */
const ALLOWED_PROPERTIES = Object.freeze(new Set([
  'meetupId', 'roomId', 'userId',
  'status', 'fromStatus', 'toStatus',
  'code', 'reason', 'result', 'environment',
  'engagementState', 'lifecycleStatus',
  'roomAgeHours', 'memberCount', 'participantCount',
  'proposalsLast24h', 'proposalsLast7d', 'limit', 'window',
  'cooldownHoursRemaining', 'expiresInHours',
  'idempotent', 'replayed', 'enabled', 'expiredCount', 'latencyMs',
]));

/** Drops every property that is not explicitly allowed. */
function sanitizeProperties(props = {}) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_PROPERTIES.has(k)) continue;
    if (v === undefined) continue;
    // Even an allowed key may not carry an object — that is how a document leaks.
    if (v !== null && typeof v === 'object') continue;
    out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
  }
  return out;
}

/**
 * Emits one Meetup lifecycle event.
 *
 * Observational only: it never throws, and nothing branches on its result.
 */
function emitMeetupEvent(event, props = {}) {
  try {
    const { MEETUP_CONFIG } = require('./meetupConfig');
    if (!MEETUP_CONFIG.ENABLED) return;
    console.log('[MEETUP]', JSON.stringify({
      event,
      environment: process.env.NODE_ENV || 'development',
      at: new Date().toISOString(),
      ...sanitizeProperties(props),
    }));
  } catch (_) {
    // Observability must never affect behaviour.
  }
}

module.exports = {
  MEETUP_EVENT,
  MEETUP_ERROR,
  ALLOWED_PROPERTIES,
  sanitizeProperties,
  emitMeetupEvent,
};
