// services/aiHost/aiHostService.js
// -----------------------------------------------------------------------------
// R6.1 — the AI Host facade. The one place the rest of Humrah may enter from.
//
// WHAT THIS DOES NOT DO, deliberately:
//   - it does not decide to intervene            (R6.2)
//   - it does not write a Room message           (R6.2)
//   - it does not emit a socket event            (R6.2)
//   - it is not called by any job, socket or route in R6.1
//
// It is unreferenced production code on purpose: R6.1 ships the foundation with
// the wiring absent, so deploying it cannot change behaviour even by accident.
//
// FAILURE ISOLATION: every export resolves. Nothing here throws into a caller,
// and nothing here is on the message-persistence path, so an AI fault cannot
// affect chat, sockets, typing, reactions, read state, invitations or R5.
// -----------------------------------------------------------------------------
'use strict';

const { AI_HOST_CONFIG, AI_HOST_IDENTITY } = require('./aiHostConfig');
const { buildAiHostContext, buildSystemInstructions } = require('./aiHostContextBuilder');
const { evaluateAiHostEligibility, AI_HOST_REASON } = require('./aiHostEligibilityService');

/** True only when the AI Host may do anything at all. */
function isAiHostEnabled() {
  return AI_HOST_CONFIG.ENABLED === true;
}

/**
 * Server-side provider selection. The choice comes from AI_HOST_PROVIDER and can
 * never be influenced by a client, a Room, or a Room message.
 *
 * Loaded lazily so a disabled AI Host never even constructs a provider.
 */
function resolveProvider() {
  if (AI_HOST_CONFIG.PROVIDER === 'cerebras') return require('../providers/cerebrasProvider');
  return require('../providers/groqProvider');
}

/**
 * Structured log for AI Host activity. IDs, enums, counts and latency only —
 * never a prompt, a completion, a message body, a name or a token.
 * Silent when the AI Host is disabled, so an inactive feature adds no log noise.
 */
function logAiHost(event, props = {}) {
  try {
    if (!AI_HOST_CONFIG.ENABLED) return;
    console.log('[AI_HOST]', JSON.stringify({
      event,
      dryRun: AI_HOST_CONFIG.DRY_RUN === true,
      at: new Date().toISOString(),
      ...props,
    }));
  } catch (_) { /* observability must never affect behaviour */ }
}

/**
 * Foundation entry point: "could the AI Host help this Room?"
 *
 * Pure delegation to the deterministic evaluator; it exists so R6.2 has one
 * import rather than reaching into internals.
 */
function assessRoom(input) {
  const decision = evaluateAiHostEligibility(input);
  // Only log a positive finding. An hourly "not eligible" line per Room is how
  // logs become unreadable.
  if (decision.eligible) {
    logAiHost('ai_host_room_eligible', {
      roomId: decision.roomId,
      engagementState: decision.engagementState,
      reason: decision.reason,
    });
  }
  return decision;
}

/**
 * Builds the bounded, sanitized request the AI Host WOULD send.
 *
 * Returns the prepared payload without calling anything. R6.2 supplies the task
 * text and decides whether to execute it.
 *
 * @returns {{ok:boolean, reason?:string, system?:string, user?:string, stats?:object, limits?:object}}
 */
function prepareRequest({ room, engagementState, messages, participantCount, task = '' }) {
  if (!isAiHostEnabled()) return { ok: false, reason: AI_HOST_REASON.DISABLED };

  const { context, prompt, stats } = buildAiHostContext({ room, engagementState, messages, participantCount });
  return {
    ok: true,
    system: buildSystemInstructions(task),
    user: prompt,
    context,
    stats,
    limits: {
      maxTokens: AI_HOST_CONFIG.MAX_OUTPUT_TOKENS,
      timeoutMs: AI_HOST_CONFIG.REQUEST_TIMEOUT_MS,
      model: AI_HOST_CONFIG.MODEL,
    },
  };
}

/**
 * Executes a prepared request against the provider.
 *
 * Present so the provider contract is exercised and testable in R6.1, but NOT
 * called from anywhere in R6.1. It refuses when the AI Host is disabled and
 * refuses again under DRY_RUN, so two independent flags stand between a deploy
 * and a real network call.
 *
 * Always resolves.
 */
async function executePrepared(prepared, options = {}) {
  if (!isAiHostEnabled()) return { ok: false, errorKind: 'permanent', error: AI_HOST_REASON.DISABLED, latencyMs: 0 };
  if (!prepared || prepared.ok !== true) return { ok: false, errorKind: 'permanent', error: 'request not prepared', latencyMs: 0 };
  if (AI_HOST_CONFIG.DRY_RUN && options.force !== true) {
    return { ok: false, errorKind: 'permanent', error: 'AI_HOST_DRY_RUN', latencyMs: 0 };
  }

  // Required lazily so that a disabled AI Host never even loads a provider.
  const provider = options.provider || resolveProvider();

  let result;
  try {
    result = await provider.complete({
      system: prepared.system,
      user: prepared.user,
      maxTokens: prepared.limits.maxTokens,
      timeoutMs: prepared.limits.timeoutMs,
      model: prepared.limits.model,
    });
  } catch (err) {
    // A provider that throws despite the contract must still not escape.
    result = { ok: false, errorKind: 'transient', error: 'provider threw', latencyMs: 0 };
  }

  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    result = { ok: false, errorKind: 'transient', error: 'malformed provider result', latencyMs: 0 };
  }

  logAiHost('ai_host_provider_call', {
    ok: result.ok,
    errorKind: result.errorKind || null,
    latencyMs: result.latencyMs || 0,
    // Length only — never the text itself.
    outputChars: result.ok && typeof result.text === 'string' ? result.text.length : 0,
  });

  return result;
}

module.exports = {
  AI_HOST_IDENTITY,
  AI_HOST_CONFIG,
  isAiHostEnabled,
  resolveProvider,
  assessRoom,
  prepareRequest,
  executePrepared,
  logAiHost,
};
