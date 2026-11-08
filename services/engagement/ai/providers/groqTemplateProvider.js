// services/engagement/ai/providers/groqTemplateProvider.js
// -----------------------------------------------------------------------------
// Groq adapter for template generation (Phase 2) — the fallback provider. Implements
// the existing AiProvider.complete() contract; never throws.
//
// REST (OpenAI-compatible): POST {baseUrl}/openai/v1/chat/completions, Bearer key,
// response_format json_object. Credential: ENGAGEMENT_AI_GROQ_API_KEY only (never
// GROQ_API_KEY or AI_HOST_GROQ_API_KEY). Model: ENGAGEMENT_AI_GROQ_MODEL (no default —
// Groq is unused until an operator names a model).
// -----------------------------------------------------------------------------
'use strict';

const axios = require('axios');
const AiProvider = require('../../../providers/aiProviderAbstract');
const { classifyAxiosError } = require('./httpErrors');

const groqExtract = {
  code: b => b && b.error && (b.error.code || b.error.type),
  message: b => (b && b.error && b.error.message) || '',
  retryMs: () => null,   // Groq uses the Retry-After header (handled by the classifier)
};

class GroqTemplateProvider extends AiProvider {
  constructor() { super(); this.name = 'groq'; }

  isConfigured(model) {
    return !!(process.env.ENGAGEMENT_AI_GROQ_API_KEY && String(process.env.ENGAGEMENT_AI_GROQ_API_KEY).trim() && model);
  }

  async complete({ system, user, maxTokens, timeoutMs, model, baseUrl, temperature } = {}) {
    const started = Date.now();
    const key = process.env.ENGAGEMENT_AI_GROQ_API_KEY ? String(process.env.ENGAGEMENT_AI_GROQ_API_KEY).trim() : '';
    if (!key) return { ok: false, kind: 'AUTH', errorKind: 'permanent', code: 'NOT_CONFIGURED', latencyMs: 0 };
    if (typeof system !== 'string' || typeof user !== 'string' || !user.trim() || !model) {
      return { ok: false, kind: 'PERMANENT', errorKind: 'permanent', code: 'INVALID_REQUEST', latencyMs: 0 };
    }
    try {
      const res = await axios.post(`${baseUrl}/openai/v1/chat/completions`, {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        timeout: timeoutMs,
        maxContentLength: 512 * 1024,
        validateStatus: s => s >= 200 && s < 300,
      });
      const choice = res.data && Array.isArray(res.data.choices) ? res.data.choices[0] : null;
      const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
      if (!text.trim()) return { ok: false, kind: 'MALFORMED', errorKind: 'transient', code: 'EMPTY_RESPONSE', httpStatus: res.status, latencyMs: Date.now() - started };
      return { ok: true, text, httpStatus: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      const c = classifyAxiosError(err, groqExtract);
      // Groq answers 400 json_validate_failed when the model did not produce valid JSON.
      if (c.kind === 'PERMANENT' && /json_validate_failed/i.test(c.code || '')) {
        return { ok: false, kind: 'MALFORMED', errorKind: 'transient', code: 'JSON_VALIDATE_FAILED', httpStatus: c.httpStatus, latencyMs: Date.now() - started };
      }
      return { ok: false, kind: c.kind, errorKind: c.kind === 'TRANSIENT' ? 'transient' : 'permanent', code: c.code, httpStatus: c.httpStatus, retryMs: c.retryMs || null, latencyMs: Date.now() - started };
    }
  }
}

module.exports = new GroqTemplateProvider();
module.exports.GroqTemplateProvider = GroqTemplateProvider;
