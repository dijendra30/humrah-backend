// services/aiHost/aiHostConfig.js
// -----------------------------------------------------------------------------
// R6.1 — every AI Host tunable, in one place.
//
// Humrah 1.0.0 is live and R5 engagement is live. This file exists so that
// deploying the AI Host foundation changes NOTHING until someone deliberately
// flips AI_HOST_ENABLED. Nothing else in the codebase may hard-code an AI limit.
//
// AI_HOST_ENABLED is deliberately INDEPENDENT of ROOM_ENGAGEMENT_ENABLED: the
// engagement engine and the AI Host are separate systems and must be switchable
// separately.
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

const AI_HOST_CONFIG = {
  // ── Master switch. SAFE DEFAULT. ─────────────────────────────────────────
  // False means: no eligibility ever passes, no context is built, no provider
  // is constructed, no network request leaves the server.
  ENABLED: bool(process.env.AI_HOST_ENABLED, false),

  // Evaluate and log a decision, but never call the provider. For a future
  // rollout; independent of ENABLED so it can be layered on top.
  DRY_RUN: bool(process.env.AI_HOST_DRY_RUN, true),

  // ── Context boundary (Step 6) ────────────────────────────────────────────
  // Deterministic caps. A Room with 50,000 messages costs exactly the same as a
  // Room with 13, because only the newest MAX_MESSAGES are ever considered.
  MAX_MESSAGES: num(process.env.AI_HOST_MAX_MESSAGES, 12),
  MAX_MESSAGE_CHARS: num(process.env.AI_HOST_MAX_MESSAGE_CHARS, 280),
  MAX_CONTEXT_CHARS: num(process.env.AI_HOST_MAX_CONTEXT_CHARS, 4000),
  MAX_TOPIC_CHARS: num(process.env.AI_HOST_MAX_TOPIC_CHARS, 80),

  // ── Cost + latency ceiling (Step 11) ─────────────────────────────────────
  MAX_OUTPUT_TOKENS: num(process.env.AI_HOST_MAX_OUTPUT_TOKENS, 200),
  REQUEST_TIMEOUT_MS: num(process.env.AI_HOST_REQUEST_TIMEOUT_MS, 8000),

  // ── Intervention pacing foundation (consumed by R6.2, not by R6.1) ───────
  ROOM_COOLDOWN_HOURS: num(process.env.AI_HOST_ROOM_COOLDOWN_HOURS, 24),
  MAX_INTERVENTIONS_PER_ROOM_PER_DAY: num(process.env.AI_HOST_MAX_PER_ROOM_PER_DAY, 1),

  // ── Eligibility gates (Step 8) ───────────────────────────────────────────
  MIN_MEMBERS: num(process.env.AI_HOST_MIN_MEMBERS, 2),
  MIN_PRIOR_PARTICIPANTS: num(process.env.AI_HOST_MIN_PRIOR_PARTICIPANTS, 2),

  // ── Provider + credentials (Step 13) ─────────────────────────────────────
  // The AI Host has its OWN keys and never borrows GROQ_API_KEY / GEMINI_API_KEY,
  // which belong to profile extraction and the profile assistant. Separate keys
  // keep the two budgets separately attributable and independently revocable.
  //   groq     -> AI_HOST_GROQ_API_KEY
  //   cerebras -> AI_HOST_CEREBRAS_API_KEY
  // Server-selected only. A client can never choose a provider or a model.
  PROVIDER: (() => {
    const p = String(process.env.AI_HOST_PROVIDER || 'groq').trim().toLowerCase();
    return ['groq', 'cerebras'].includes(p) ? p : 'groq';
  })(),

  // Which model the AI Host would use. Never client-selectable.
  // Left null so each provider applies its own default naming: Groq expects
  // "openai/gpt-oss-120b", Cerebras expects "gpt-oss-120b" for the same model.
  MODEL: process.env.AI_HOST_MODEL || null,
};

/**
 * The AI Host's explicit identity (Step 3).
 *
 * It is NOT a user, has no account, no human name, and no RoomMember row. Any
 * future UI must be able to label its messages unambiguously as AI. Nothing here
 * is ever presented as a person.
 */
const AI_HOST_IDENTITY = Object.freeze({
  kind: 'AI_HOST',
  displayName: 'Humrah Host',
  isAi: true,
  isHuman: false,
});

module.exports = { AI_HOST_CONFIG, AI_HOST_IDENTITY };
