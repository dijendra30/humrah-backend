// services/engagement/ai/notificationAiService.js
// -----------------------------------------------------------------------------
// NotificationAIService — provider selection, fallback, retries and cooldowns for
// TEMPLATE GENERATION ONLY. Called once per generation batch, never per recipient; the
// Phase 1 worker never calls it.
//
// One pass through [primary, fallback] — never a loop between providers. For each:
//   skip if not configured, cooling down, over its daily request cap, or asked too soon
//     after its previous request (minimum spacing) — all shared through Mongo
//     (EngagementAiProviderState), so they hold across restarts and instances;
//   up to ENGAGEMENT_AI_MAX_ATTEMPTS attempts, with exponential backoff, only for
//     TRANSIENT / MALFORMED results;
//   RATE_LIMIT → cooldown (provider's retry hint, else base × 2^failures, capped), no retry;
//   QUOTA      → long cooldown (ENGAGEMENT_AI_QUOTA_COOLDOWN_MINUTES), no retry, no re-spend;
//   AUTH       → long cooldown (ENGAGEMENT_AI_AUTH_COOLDOWN_MINUTES), no retry;
//   PERMANENT  → no retry;
//   repeated failures (ENGAGEMENT_AI_FAILURE_THRESHOLD) → escalating cooldown.
// Returns the text of the first success plus every attempt (codes only) for history.
// -----------------------------------------------------------------------------
'use strict';

const EngagementAiProviderState = require('../../../models/EngagementAiProviderState');
const aiConfig = require('../../../config/engagementAiConfig');
const log = require('../log');

const ADAPTERS = {
  gemini: () => require('./providers/geminiTemplateProvider'),
  groq: () => require('./providers/groqTemplateProvider'),
};

let adapterOverride = null;          // tests only: { gemini, groq }
let sleepImpl = ms => new Promise(r => setTimeout(r, ms));
function _setAdaptersForTests(a) { adapterOverride = a; }
function _setSleepForTests(fn) { sleepImpl = fn || (ms => new Promise(r => setTimeout(r, ms))); }
const adapter = name => (adapterOverride && adapterOverride[name]) || ADAPTERS[name]();

const dayKey = now => new Date(now).toISOString().slice(0, 10);

async function loadState(name) {
  return (await EngagementAiProviderState.findById(name).lean()) || { _id: name, consecutiveFailures: 0, requestsToday: 0 };
}

/** Why this provider cannot be asked right now, or null. */
function availability(name, state, cfg, now) {
  const pcfg = cfg.providers[name];
  if (!pcfg || !pcfg.model || !adapter(name).isConfigured(pcfg.model)) return 'NOT_CONFIGURED';
  if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now) return `COOLDOWN_${state.cooldownReason || 'ACTIVE'}`;
  if (state.dayKey === dayKey(now) && state.requestsToday >= pcfg.dailyRequestCap) return 'DAILY_CAP';
  if (state.lastRequestAt && now - new Date(state.lastRequestAt).getTime() < pcfg.minIntervalMs) return 'MIN_INTERVAL';
  return null;
}

/** Count the request (atomic) before it is sent. */
async function countRequest(name, now) {
  const dk = dayKey(now);
  const r = await EngagementAiProviderState.updateOne({ _id: name, dayKey: dk }, { $inc: { requestsToday: 1 }, $set: { lastRequestAt: new Date(now) } });
  if (r.matchedCount === 0) {
    await EngagementAiProviderState.updateOne({ _id: name }, { $set: { dayKey: dk, requestsToday: 1, lastRequestAt: new Date(now) } }, { upsert: true });
  }
}

function cooldownFor(kind, result, state, cfg) {
  const failures = (state.consecutiveFailures || 0) + 1;
  if (kind === 'QUOTA') return cfg.quotaCooldownMs;
  if (kind === 'AUTH') return cfg.authCooldownMs;
  if (kind === 'RATE_LIMIT') {
    const hint = Number.isFinite(result.retryMs) && result.retryMs > 0 ? result.retryMs : 0;
    return Math.min(cfg.maxCooldownMs, Math.max(hint, cfg.rateLimitCooldownMs * 2 ** Math.min(failures - 1, 6)));
  }
  if (failures >= cfg.failureThreshold) return Math.min(cfg.maxCooldownMs, cfg.failureCooldownMs * 2 ** Math.min(failures - cfg.failureThreshold, 6));
  return 0;
}

async function recordFailure(name, kind, result, cfg, now) {
  const state = await loadState(name);
  const cd = cooldownFor(kind, result, state, cfg);
  const set = { lastFailureAt: new Date(now), lastFailureCode: String(result.code || kind).slice(0, 60) };
  if (cd > 0) Object.assign(set, { cooldownUntil: new Date(now + cd), cooldownReason: kind });
  await EngagementAiProviderState.updateOne({ _id: name }, { $set: set, $inc: { consecutiveFailures: 1 } }, { upsert: true });
  if (cd > 0) log.warn('ai_provider_cooldown', { provider: name, reason: kind, code: set.lastFailureCode, cooldownSeconds: Math.round(cd / 1000) });
}

async function recordSuccess(name, now) {
  await EngagementAiProviderState.updateOne({ _id: name }, { $set: { consecutiveFailures: 0, lastSuccessAt: new Date(now), cooldownUntil: null, cooldownReason: null } }, { upsert: true });
}

/**
 * @param {{system:string, user:string}} prompt  generic generation instructions (no user data)
 * @param {object} [opts] { cfg, now: () => ms, validateText: (text) => boolean }
 *   validateText lets the caller treat an unparseable answer as MALFORMED (retry/fallback).
 * @returns {Promise<{ok:boolean, provider?:string, model?:string, text?:string, attempts:object[], failureReason?:string}>}
 */
async function generate(prompt, opts = {}) {
  const cfg = opts.cfg || aiConfig.get();
  const now = opts.now || (() => Date.now());
  const validateText = opts.validateText || (() => true);
  const order = [cfg.primary, cfg.fallback].filter((p, i, a) => p && a.indexOf(p) === i);
  const attempts = [];

  for (const name of order) {
    const pcfg = cfg.providers[name];
    const state = await loadState(name);
    const why = availability(name, state, cfg, now());
    if (why) {
      attempts.push({ provider: name, model: pcfg && pcfg.model, outcome: 'SKIPPED', code: why, httpStatus: null, durationMs: 0, at: new Date(now()) });
      continue;
    }
    for (let a = 1; a <= cfg.maxAttemptsPerProvider; a++) {
      const t = now();
      await countRequest(name, t);
      let r = await adapter(name).complete({
        system: prompt.system, user: prompt.user, model: pcfg.model, baseUrl: pcfg.baseUrl,
        timeoutMs: cfg.timeoutMs, maxTokens: cfg.maxOutputTokens, temperature: cfg.temperature,
      });
      if (r.ok && !validateText(r.text)) r = { ok: false, kind: 'MALFORMED', code: 'INVALID_JSON', httpStatus: r.httpStatus, latencyMs: r.latencyMs };
      attempts.push({ provider: name, model: pcfg.model, outcome: r.ok ? 'OK' : r.kind, code: r.ok ? null : String(r.code || r.kind).slice(0, 60), httpStatus: r.httpStatus || null, durationMs: r.latencyMs || 0, at: new Date(t) });
      if (r.ok) {
        await recordSuccess(name, now());
        log.info('ai_provider_ok', { provider: name, model: pcfg.model, attempt: a, durationMs: r.latencyMs });
        return { ok: true, provider: name, model: pcfg.model, text: r.text, attempts };
      }
      log.warn('ai_provider_failed', { provider: name, outcome: r.kind, code: r.code, httpStatus: r.httpStatus || null, attempt: a });
      const retryable = (r.kind === 'TRANSIENT' || r.kind === 'MALFORMED') && a < cfg.maxAttemptsPerProvider;
      if (!retryable) { await recordFailure(name, r.kind, r, cfg, now()); break; }
      await sleepImpl(cfg.retryBaseMs * 2 ** (a - 1));
    }
  }
  const last = attempts[attempts.length - 1];
  const failureReason = attempts.every(x => x.outcome === 'SKIPPED') ? 'NO_PROVIDER_AVAILABLE' : `ALL_PROVIDERS_FAILED${last && last.code ? ':' + last.code : ''}`.slice(0, 60);
  return { ok: false, attempts, failureReason };
}

/** Health for the admin API: configuration presence and state codes — never a key. */
async function health(opts = {}) {
  const cfg = opts.cfg || aiConfig.get();
  const now = Date.now();
  const out = {};
  for (const name of aiConfig.PROVIDERS) {
    const s = await loadState(name);
    const pcfg = cfg.providers[name];
    out[name] = {
      role: name === cfg.primary ? 'primary' : name === cfg.fallback ? 'fallback' : 'unused',
      keyConfigured: aiConfig.hasKey(name),
      model: pcfg.model,
      available: availability(name, s, cfg, now) === null,
      unavailableReason: availability(name, s, cfg, now),
      cooldownUntil: s.cooldownUntil || null,
      consecutiveFailures: s.consecutiveFailures || 0,
      lastSuccessAt: s.lastSuccessAt || null,
      lastFailureAt: s.lastFailureAt || null,
      lastFailureCode: s.lastFailureCode || null,
      requestsToday: s.dayKey === dayKey(now) ? s.requestsToday : 0,
      dailyRequestCap: pcfg.dailyRequestCap,
    };
  }
  return { enabled: cfg.enabled, scheduleEnabled: cfg.scheduleEnabled, approvalPolicy: cfg.approvalPolicy, providers: out };
}

module.exports = { generate, health, availability, cooldownFor, _setAdaptersForTests, _setSleepForTests, _internal: { dayKey, loadState } };
