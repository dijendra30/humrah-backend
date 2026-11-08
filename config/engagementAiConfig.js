// config/engagementAiConfig.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — Phase 2 (AI Notification Studio) settings.
//
// SAFE DEFAULTS: ENGAGEMENT_AI_ENABLED=false (no provider is ever called, manual or
// scheduled) and ENGAGEMENT_AI_SCHEDULE_ENABLED=false. AI generation is independent of
// notification delivery: the Phase 1 worker never calls a provider and keeps working
// from already-approved templates whatever happens here.
//
// Credentials: this feature has its OWN keys (the AI Host convention, aiHostConfig.js):
// ENGAGEMENT_AI_GEMINI_API_KEY / ENGAGEMENT_AI_GROQ_API_KEY. It never borrows
// GEMINI_API_KEY / GROQ_API_KEY, so each budget stays attributable and independently
// revocable. Keys are read only inside the provider adapters and are never returned,
// logged or stored.
//
// Read on every use (no caching) — the same convention as engagementNotificationConfig.
// -----------------------------------------------------------------------------
'use strict';

const LANGUAGES = Object.freeze(['en', 'hi', 'hinglish']);
const TONES = Object.freeze(['friendly', 'conversational', 'funny', 'informative', 'curious', 'community', 'warm', 'lighthearted']);
const PROVIDERS = Object.freeze(['gemini', 'groq']);
const APPROVAL_POLICIES = Object.freeze(['manual', 'auto_approve']);

const warned = new Set();
function warnOnce(key, text) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[ENGAGEMENT_AI] ${text}`);
}
const raw = name => {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
};
const envBool = (name, def) => { const v = raw(name); return v === null ? def : v.toLowerCase() === 'true'; };
function envInt(name, def, min, max) {
  const v = raw(name);
  if (v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) { warnOnce(`int:${name}`, `${name} must be a whole number from ${min} to ${max}; using ${def}.`); return def; }
  return n;
}
function envEnum(name, def, allowed) {
  const v = raw(name);
  if (v === null) return def;
  const s = v.toLowerCase();
  if (!allowed.includes(s)) { warnOnce(`enum:${name}`, `${name} must be one of ${allowed.join(', ')}; using ${def}.`); return def; }
  return s;
}
function envList(name, def, allowed) {
  const v = raw(name);
  if (v === null) return [...def];
  const list = v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const ok = list.filter(x => allowed.includes(x));
  if (ok.length !== list.length) warnOnce(`list:${name}`, `${name} has unknown entries; they are ignored.`);
  return [...new Set(ok)];
}
// Model ids: letters, digits, dot, dash, underscore, slash, colon. Anything else is refused.
const MODEL_RE = /^[A-Za-z0-9._\-/:]{1,100}$/;
function envModel(name, def) {
  const v = raw(name);
  if (v === null) return def;
  if (!MODEL_RE.test(v)) { warnOnce(`model:${name}`, `${name} is not a valid model id; using the default.`); return def; }
  return v;
}
function envUrl(name, def) {
  const v = raw(name);
  if (v === null) return def;
  if (!/^https?:\/\/[^\s]+$/.test(v)) { warnOnce(`url:${name}`, `${name} is not a URL; using the default.`); return def; }
  return v.replace(/\/+$/, '');
}

function get() {
  const primary = envEnum('ENGAGEMENT_AI_PRIMARY_PROVIDER', 'gemini', PROVIDERS);
  const fallbackRaw = raw('ENGAGEMENT_AI_FALLBACK_PROVIDER');
  const fallback = fallbackRaw && fallbackRaw.toLowerCase() === 'none' ? null : envEnum('ENGAGEMENT_AI_FALLBACK_PROVIDER', 'groq', PROVIDERS);
  return {
    enabled: envBool('ENGAGEMENT_AI_ENABLED', false),
    scheduleEnabled: envBool('ENGAGEMENT_AI_SCHEDULE_ENABLED', false),
    scheduleIntervalMs: envInt('ENGAGEMENT_AI_SCHEDULE_INTERVAL_HOURS', 24, 1, 24 * 30) * 3600 * 1000,
    scheduleLanguages: envList('ENGAGEMENT_AI_SCHEDULE_LANGUAGES', ['en'], LANGUAGES),
    targetPoolSize: envInt('ENGAGEMENT_AI_TARGET_POOL_SIZE', 6, 1, 50),
    maxBatchesPerRun: envInt('ENGAGEMENT_AI_MAX_BATCHES_PER_RUN', 2, 1, 20),

    primary,
    fallback: fallback === primary ? null : fallback,
    providers: {
      gemini: {
        model: envModel('ENGAGEMENT_AI_GEMINI_MODEL', 'gemini-2.5-flash-lite'),
        baseUrl: envUrl('ENGAGEMENT_AI_GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com'),
        dailyRequestCap: envInt('ENGAGEMENT_AI_GEMINI_DAILY_REQUEST_CAP', 50, 1, 100000),
        minIntervalMs: envInt('ENGAGEMENT_AI_GEMINI_MIN_INTERVAL_SECONDS', 5, 0, 3600) * 1000,
      },
      groq: {
        // No default model: Groq is only used once an operator names one.
        model: envModel('ENGAGEMENT_AI_GROQ_MODEL', null),
        baseUrl: envUrl('ENGAGEMENT_AI_GROQ_BASE_URL', 'https://api.groq.com'),
        dailyRequestCap: envInt('ENGAGEMENT_AI_GROQ_DAILY_REQUEST_CAP', 50, 1, 100000),
        minIntervalMs: envInt('ENGAGEMENT_AI_GROQ_MIN_INTERVAL_SECONDS', 5, 0, 3600) * 1000,
      },
    },
    timeoutMs: envInt('ENGAGEMENT_AI_TIMEOUT_SECONDS', 20, 3, 120) * 1000,
    maxAttemptsPerProvider: envInt('ENGAGEMENT_AI_MAX_ATTEMPTS', 2, 1, 5),
    retryBaseMs: envInt('ENGAGEMENT_AI_RETRY_BASE_MS', 1000, 0, 60000),
    rateLimitCooldownMs: envInt('ENGAGEMENT_AI_RATE_LIMIT_COOLDOWN_SECONDS', 120, 1, 24 * 3600) * 1000,
    quotaCooldownMs: envInt('ENGAGEMENT_AI_QUOTA_COOLDOWN_MINUTES', 360, 1, 7 * 24 * 60) * 60 * 1000,
    authCooldownMs: envInt('ENGAGEMENT_AI_AUTH_COOLDOWN_MINUTES', 720, 1, 7 * 24 * 60) * 60 * 1000,
    failureCooldownMs: envInt('ENGAGEMENT_AI_FAILURE_COOLDOWN_MINUTES', 15, 1, 24 * 60) * 60 * 1000,
    failureThreshold: envInt('ENGAGEMENT_AI_FAILURE_THRESHOLD', 3, 1, 20),
    maxCooldownMs: 24 * 3600 * 1000,

    maxBatchSize: envInt('ENGAGEMENT_AI_MAX_BATCH_SIZE', 8, 1, 20),
    titleMax: envInt('ENGAGEMENT_AI_TITLE_MAX', 60, 20, 65),
    bodyMax: envInt('ENGAGEMENT_AI_BODY_MAX', 140, 40, 180),
    temperature: envInt('ENGAGEMENT_AI_TEMPERATURE_PERCENT', 90, 0, 150) / 100,
    maxOutputTokens: envInt('ENGAGEMENT_AI_MAX_OUTPUT_TOKENS', 2048, 256, 8192),
    defaultLanguage: envEnum('ENGAGEMENT_AI_DEFAULT_LANGUAGE', 'en', LANGUAGES),
    approvalPolicy: envEnum('ENGAGEMENT_AI_APPROVAL_POLICY', 'manual', APPROVAL_POLICIES),
    regenMinMs: envInt('ENGAGEMENT_AI_REGEN_MIN_HOURS', 72, 0, 24 * 90) * 3600 * 1000,
    lockMs: envInt('ENGAGEMENT_AI_LOCK_SECONDS', 300, 60, 3600) * 1000,
    similarityThreshold: envInt('ENGAGEMENT_AI_SIMILARITY_PERCENT', 75, 50, 100) / 100,
  };
}

/** Never returns the key value — only whether one is present. */
function hasKey(provider) {
  if (provider === 'gemini') return !!raw('ENGAGEMENT_AI_GEMINI_API_KEY');
  if (provider === 'groq') return !!raw('ENGAGEMENT_AI_GROQ_API_KEY');
  return false;
}

module.exports = { get, hasKey, LANGUAGES, TONES, PROVIDERS, APPROVAL_POLICIES, MODEL_RE };
