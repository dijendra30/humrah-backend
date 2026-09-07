const AiProvider = require('./aiProviderAbstract');
const axios = require('axios');

class GroqProvider extends AiProvider {
  async extractProfile(userText, schemaPrompt) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY not configured');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: schemaPrompt },
          { role: 'user', content: userText }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000 // 8s strict timeout
      }
    );

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  }

  /**
   * R6.1 — bounded completion for the AI Host. Additive: extractProfile above is
   * untouched, so the profile-extraction path is unaffected.
   *
   * Never throws. Classifies failures so a caller can distinguish "retry later"
   * from "this will never work".
   */
  async complete({ system, user, maxTokens, timeoutMs, model } = {}) {
    const started = Date.now();
    // DEDICATED AI HOST CREDENTIAL. Deliberately NOT falling back to
    // GROQ_API_KEY: the AI Host must never spend the profile-extraction /
    // profile-assistant key, so the two budgets stay separately attributable and
    // either can be revoked without affecting the other. A missing key is a
    // permanent failure — retrying cannot help.
    const apiKey = process.env.AI_HOST_GROQ_API_KEY;
    if (!apiKey) {
      return { ok: false, errorKind: 'permanent', error: 'AI_HOST_GROQ_API_KEY not configured', latencyMs: 0 };
    }
    if (typeof system !== 'string' || typeof user !== 'string' || !user.trim()) {
      return { ok: false, errorKind: 'permanent', error: 'invalid request payload', latencyMs: 0 };
    }

    try {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: model || process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
          messages: [
            // The trust boundary: instructions are system, Room content is user.
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.6,
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: timeoutMs,
        }
      );

      const text = response?.data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        // A 200 with an unusable body is a malformed response, not a crash.
        return { ok: false, errorKind: 'transient', error: 'empty or malformed completion', latencyMs: Date.now() - started };
      }
      return { ok: true, text: text.trim(), latencyMs: Date.now() - started };
    } catch (err) {
      const status = err?.response?.status;
      const timedOut = err?.code === 'ECONNABORTED';
      // 4xx (except 429) means the request itself is wrong — retrying will not fix it.
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

module.exports = new GroqProvider();
