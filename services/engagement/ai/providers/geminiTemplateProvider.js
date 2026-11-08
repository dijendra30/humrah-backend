// services/engagement/ai/providers/geminiTemplateProvider.js
// -----------------------------------------------------------------------------
// Google Gemini adapter for template generation (Phase 2). Implements the existing
// AiProvider.complete() contract (services/providers/aiProviderAbstract.js): it never
// throws and returns a classified result.
//
// REST: POST {baseUrl}/v1beta/models/{model}:generateContent
//   key in the x-goog-api-key HEADER (never in the URL, so it cannot reach an access log)
//   generationConfig.responseMimeType = application/json
// Credential: ENGAGEMENT_AI_GEMINI_API_KEY only (never GEMINI_API_KEY — see engagementAiConfig).
// The request carries only the generic prompt built by ai/prompt.js. No user data exists in it.
// -----------------------------------------------------------------------------
'use strict';

const axios = require('axios');
const AiProvider = require('../../../providers/aiProviderAbstract');
const { classifyAxiosError, parseRetryMs } = require('./httpErrors');

const geminiExtract = {
  code: b => b && b.error && (b.error.status || (b.error.details || []).map(d => d && d.reason).find(Boolean)),
  message: b => (b && b.error && b.error.message) || '',
  retryMs: b => {
    const d = ((b && b.error && b.error.details) || []).find(x => x && typeof x['@type'] === 'string' && x['@type'].includes('RetryInfo'));
    return d ? parseRetryMs(d.retryDelay) : null;
  },
};

class GeminiTemplateProvider extends AiProvider {
  constructor() { super(); this.name = 'gemini'; }

  isConfigured(model) {
    return !!(process.env.ENGAGEMENT_AI_GEMINI_API_KEY && String(process.env.ENGAGEMENT_AI_GEMINI_API_KEY).trim() && model);
  }

  async complete({ system, user, maxTokens, timeoutMs, model, baseUrl, temperature } = {}) {
    const started = Date.now();
    const key = process.env.ENGAGEMENT_AI_GEMINI_API_KEY ? String(process.env.ENGAGEMENT_AI_GEMINI_API_KEY).trim() : '';
    if (!key) return { ok: false, kind: 'AUTH', errorKind: 'permanent', code: 'NOT_CONFIGURED', latencyMs: 0 };
    if (typeof system !== 'string' || typeof user !== 'string' || !user.trim() || !model) {
      return { ok: false, kind: 'PERMANENT', errorKind: 'permanent', code: 'INVALID_REQUEST', latencyMs: 0 };
    }
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const res = await axios.post(url, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        timeout: timeoutMs,
        maxContentLength: 512 * 1024,
        validateStatus: s => s >= 200 && s < 300,
      });
      const cand = res.data && Array.isArray(res.data.candidates) ? res.data.candidates[0] : null;
      const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      const text = parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('');
      if (!text.trim()) {
        const blocked = (res.data && res.data.promptFeedback && res.data.promptFeedback.blockReason) || (cand && cand.finishReason);
        return { ok: false, kind: 'MALFORMED', errorKind: 'transient', code: blocked ? `EMPTY_${String(blocked).slice(0, 30)}` : 'EMPTY_RESPONSE', httpStatus: res.status, latencyMs: Date.now() - started };
      }
      return { ok: true, text, httpStatus: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      const c = classifyAxiosError(err, geminiExtract);
      return { ok: false, kind: c.kind, errorKind: c.kind === 'TRANSIENT' ? 'transient' : 'permanent', code: c.code, httpStatus: c.httpStatus, retryMs: c.retryMs || null, latencyMs: Date.now() - started };
    }
  }
}

module.exports = new GeminiTemplateProvider();
module.exports.GeminiTemplateProvider = GeminiTemplateProvider;
