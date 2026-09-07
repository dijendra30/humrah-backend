// services/providers/cerebrasProvider.js
// -----------------------------------------------------------------------------
// R6.1 — Cerebras implementation of the AI provider contract.
//
// Implements complete() ONLY. It is not part of the profile-extraction chain
// (aiProfileService), so extractProfile deliberately stays unimplemented and the
// base class's fail-closed default applies if anything ever calls it.
//
// Uses its OWN credential, AI_HOST_CEREBRAS_API_KEY, with no fallback to any
// other key in the project.
//
// Cerebras exposes an OpenAI-compatible chat/completions endpoint, so this is the
// same request shape as groqProvider — which is exactly why the AI Host talks to
// the abstraction rather than to a vendor.
// -----------------------------------------------------------------------------
'use strict';

const AiProvider = require('./aiProviderAbstract');
const axios = require('axios');

const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';

class CerebrasProvider extends AiProvider {
  /** Never throws. Same structured contract as every other provider. */
  async complete({ system, user, maxTokens, timeoutMs, model } = {}) {
    const started = Date.now();
    const apiKey = process.env.AI_HOST_CEREBRAS_API_KEY;
    if (!apiKey) {
      return { ok: false, errorKind: 'permanent', error: 'AI_HOST_CEREBRAS_API_KEY not configured', latencyMs: 0 };
    }
    if (typeof system !== 'string' || typeof user !== 'string' || !user.trim()) {
      return { ok: false, errorKind: 'permanent', error: 'invalid request payload', latencyMs: 0 };
    }

    try {
      const response = await axios.post(
        CEREBRAS_URL,
        {
          model: model || process.env.AI_HOST_CEREBRAS_MODEL || 'gpt-oss-120b',
          messages: [
            // The trust boundary: instructions are system, Room content is user.
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_completion_tokens: maxTokens,
          temperature: 0.6,
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: timeoutMs,
        }
      );

      const text = response?.data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, errorKind: 'transient', error: 'empty or malformed completion', latencyMs: Date.now() - started };
      }
      return { ok: true, text: text.trim(), latencyMs: Date.now() - started };
    } catch (err) {
      const status = err?.response?.status;
      const timedOut = err?.code === 'ECONNABORTED';
      const permanent = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
      return {
        ok: false,
        errorKind: permanent ? 'permanent' : 'transient',
        // Message only — never the response body, which could echo prompt content.
        error: timedOut ? 'provider timeout' : (status ? `provider http ${status}` : 'provider network error'),
        latencyMs: Date.now() - started,
      };
    }
  }
}

module.exports = new CerebrasProvider();
