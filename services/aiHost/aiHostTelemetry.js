// services/aiHost/aiHostTelemetry.js
// -----------------------------------------------------------------------------
// R6.3 — the ONE place AI Host observability is emitted.
//
// There is no backend PostHog in this project (verified: no dependency, no
// client) and R6.3 does not add one — Step 2 forbids a second analytics stack.
// Server-side events are structured [AI_HOST] log lines; the Android app keeps
// using the existing PostHog for client-side events. The two halves join on
// aiInterventionId.
//
// SAFETY BY ALLOWLIST, not by filtering. Only the property names below survive.
// A caller that accidentally passes a transcript, a prompt, a name or a token
// cannot leak it, because unknown keys are dropped rather than sanitised — a
// filter has to anticipate every bad key, an allowlist has to anticipate none.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');

/** Stable event names. Dashboards and greps key on these — do not rename. */
const AI_EVENT = Object.freeze({
  ELIGIBLE: 'ai_host_eligible',
  SKIPPED: 'ai_host_skipped',
  CLAIMED: 'ai_host_claimed',
  CLAIM_FAILED: 'ai_host_claim_failed',
  COOLDOWN: 'ai_host_cooldown',
  RATE_LIMITED: 'ai_host_rate_limited',
  BUDGET_EXHAUSTED: 'ai_host_budget_exhausted',
  REDIS_UNAVAILABLE: 'ai_host_redis_unavailable',
  GENERATION_STARTED: 'ai_host_generation_started',
  GENERATION_SUCCEEDED: 'ai_host_generation_succeeded',
  GENERATION_FAILED: 'ai_host_generation_failed',
  OUTPUT_REJECTED: 'ai_host_output_rejected',
  MODERATION_REJECTED: 'ai_host_moderation_rejected',
  PERSISTED: 'ai_host_message_persisted',
  DELIVERED: 'ai_host_message_delivered',
  PERSIST_FAILED: 'ai_host_persist_failed',
  RUN_SUMMARY: 'ai_host_run_summary',
});

/**
 * The COMPLETE set of properties an AI Host event may carry. Every entry is an
 * id, an enum, a count, a duration or a boolean. There is deliberately no key
 * here that could hold free text written by a user or a model.
 */
const ALLOWED_PROPERTIES = Object.freeze(new Set([
  'aiInterventionId', 'roomId', 'messageId',
  'provider', 'model', 'environment',
  'result', 'reason', 'errorKind', 'outcome', 'engagementState', 'lifecycleStatus',
  'latencyMs', 'providerLatencyMs', 'totalLatencyMs',
  'messageLength', 'contextChars', 'messagesInContext', 'outputChars',
  'callsThisHour', 'callsToday', 'callsThisRun', 'limit', 'window',
  'roomsScanned', 'roomsEligible', 'roomsSkipped', 'interventions', 'failures',
  'participantsAtIntervention', 'participantsNow', 'hoursSinceIntervention',
  'dryRun', 'enabled', 'emitted', 'delivered',
]));

/** A fresh correlation id for one intervention attempt. */
function newInterventionId() {
  return `aih_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Classifies a provider/system error into a safe bucket.
 *
 * Raw provider error text may echo the prompt (and therefore the Room
 * transcript), so it is NEVER logged — only the classification is.
 */
function classifyError(err) {
  const s = typeof err === 'string' ? err : (err && err.message) || '';
  if (/timeout|ECONNABORTED/i.test(s)) return 'timeout';
  if (/http 429|rate limit/i.test(s)) return 'rate_limited';
  if (/http 5\d\d/i.test(s)) return 'provider_5xx';
  if (/http 4\d\d/i.test(s)) return 'provider_4xx';
  if (/network|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(s)) return 'network';
  if (/not configured|api[_ ]?key/i.test(s)) return 'misconfigured';
  if (/malformed|empty/i.test(s)) return 'malformed_response';
  return 'unknown';
}

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
 * Emits one AI Host lifecycle event.
 *
 * Observational only: it never throws, nothing branches on its result, and it is
 * silent while the AI Host is disabled so an inactive feature adds no log noise.
 */
function emitAiHostEvent(event, props = {}) {
  try {
    const { AI_HOST_CONFIG } = require('./aiHostConfig');
    if (!AI_HOST_CONFIG.ENABLED) return;
    console.log('[AI_HOST]', JSON.stringify({
      event,
      dryRun: AI_HOST_CONFIG.DRY_RUN === true,
      environment: process.env.NODE_ENV || 'development',
      at: new Date().toISOString(),
      ...sanitizeProperties(props),
    }));
  } catch (_) {
    // Observability must never affect behaviour.
  }
}

module.exports = {
  AI_EVENT,
  ALLOWED_PROPERTIES,
  emitAiHostEvent,
  sanitizeProperties,
  newInterventionId,
  classifyError,
};
