// services/aiHost/aiHostResponseValidator.js
// -----------------------------------------------------------------------------
// R6.2 — nothing a provider returns reaches the database or a user without
// passing through here.
//
// This is the OUTBOUND half of the trust boundary. aiHostContextBuilder guards
// what goes IN; this guards what comes OUT. A model that has been successfully
// manipulated, or that simply misbehaves, must not be able to publish its output
// into a Room.
//
// Fails CLOSED: anything it cannot confidently accept is rejected, and a rejected
// response is never persisted, never emitted, and never partially used.
// -----------------------------------------------------------------------------
'use strict';

const { AI_HOST_CONFIG } = require('./aiHostConfig');
const { CONTENT_FENCE_OPEN, CONTENT_FENCE_CLOSE } = require('./aiHostContextBuilder');

/** Why a candidate response was refused. Exactly one is returned. */
const REJECTION = {
  EMPTY: 'EMPTY_RESPONSE',
  TOO_SHORT: 'TOO_SHORT',
  TOO_LONG: 'TOO_LONG',
  NOT_TEXT: 'NOT_PLAIN_TEXT',
  LEAKED_INSTRUCTIONS: 'LEAKED_SYSTEM_INSTRUCTIONS',
  LEAKED_SECRET: 'LEAKED_CREDENTIAL',
  LEAKED_CONTACT: 'LEAKED_CONTACT_DETAILS',
  CLAIMS_HUMAN: 'CLAIMS_TO_BE_HUMAN',
  TOOL_CALL: 'TOOL_CALL_ATTEMPT',
  OK: 'OK',
};

/**
 * Phrases that indicate the model is reciting its own instructions or the
 * scaffolding around them. Any of these means the response is discarded — we do
 * not attempt to clean it up, because a partially-leaked prompt is still a leak.
 */
const INSTRUCTION_LEAK_PATTERNS = [
  /you are the humrah host/i,
  /security rules/i,
  /system (prompt|instruction|message)/i,
  /my (system )?(prompt|instructions) (are|is|say)/i,
  /as an ai (language )?model,? i (was|am) (instructed|programmed|told)/i,
  new RegExp(CONTENT_FENCE_OPEN.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'), 'i'),
  new RegExp(CONTENT_FENCE_CLOSE.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'), 'i'),
  /<\|[^|>]{0,40}\|>/,
  /^\s*(system|developer|assistant)\s*:/im,
];

/** Anything resembling a credential must never be published, whatever its source. */
const SECRET_PATTERNS = [
  /\b(gsk|sk|csk|pk)[-_][A-Za-z0-9]{16,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  /\beyJ[A-Za-z0-9._-]{20,}\b/,               // JWT
  /\b(api[_-]?key|access[_-]?token|secret)\b\s*[:=]\s*\S{8,}/i,
];

/** The Host must not hand out contact details, its own or anyone's. */
const CONTACT_PATTERNS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /(?:\+?\d[\s-]?){10,}/,
];

/** The Host is an AI and must never claim otherwise (Step 11). */
const HUMAN_CLAIM_PATTERNS = [
  /\bi(?:'m| am)\s+(?:a\s+)?(?:real\s+)?(?:human|person|guy|girl|man|woman)\b/i,
  /\bi(?:'m| am)\s+not\s+(?:an?\s+)?(?:ai|bot|robot|machine)\b/i,
  /\bi\s+live\s+in\b/i,
  /\bwhen\s+i\s+was\s+(?:a\s+)?(?:kid|child|younger|there)\b/i,
];

/** Tools are not enabled; text that tries to invoke one is discarded. */
const TOOL_CALL_PATTERNS = [
  /<\s*tool_call\b/i,
  /"function_call"\s*:/i,
  /"tool_calls"\s*:/i,
  /\bfunctions\.[A-Za-z_]\w*\s*\(/,
];

/** Whole-body JSON or a code dump is not a chat message. */
function looksStructured(text) {
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) return true;
  if (t.startsWith('```')) return true;
  if (/^\s*"?(choices|completion|usage|object|model|id)"?\s*:/i.test(t)) return true;
  return false;
}

/**
 * Validates one candidate Host message.
 *
 * @param {*} raw provider output (any type — hostile input is expected)
 * @returns {{ok:boolean, reason:string, text?:string}}
 */
function validateAiHostResponse(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: REJECTION.EMPTY };

  // Strip wrapping quotes/fences a model sometimes adds, then normalise.
  let text = raw.trim();
  if (text.startsWith('```')) return { ok: false, reason: REJECTION.NOT_TEXT };
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!text) return { ok: false, reason: REJECTION.EMPTY };
  if (looksStructured(text)) return { ok: false, reason: REJECTION.NOT_TEXT };

  // Length is checked BEFORE content patterns so an enormous leak is rejected
  // cheaply, and never truncated into something that looks acceptable.
  if (text.length > AI_HOST_CONFIG.MAX_RESPONSE_CHARS) return { ok: false, reason: REJECTION.TOO_LONG };
  if (text.length < AI_HOST_CONFIG.MIN_RESPONSE_CHARS) return { ok: false, reason: REJECTION.TOO_SHORT };

  if (TOOL_CALL_PATTERNS.some(p => p.test(text))) return { ok: false, reason: REJECTION.TOOL_CALL };
  if (INSTRUCTION_LEAK_PATTERNS.some(p => p.test(text))) return { ok: false, reason: REJECTION.LEAKED_INSTRUCTIONS };
  if (SECRET_PATTERNS.some(p => p.test(text))) return { ok: false, reason: REJECTION.LEAKED_SECRET };
  if (CONTACT_PATTERNS.some(p => p.test(text))) return { ok: false, reason: REJECTION.LEAKED_CONTACT };
  if (HUMAN_CLAIM_PATTERNS.some(p => p.test(text))) return { ok: false, reason: REJECTION.CLAIMS_HUMAN };

  return { ok: true, reason: REJECTION.OK, text };
}

module.exports = {
  validateAiHostResponse,
  REJECTION,
  // exported for tests
  INSTRUCTION_LEAK_PATTERNS,
  SECRET_PATTERNS,
  HUMAN_CLAIM_PATTERNS,
  TOOL_CALL_PATTERNS,
  looksStructured,
};
