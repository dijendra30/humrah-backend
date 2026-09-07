class AiProvider {
  /**
   * Extract JSON profile from user text
   * @param {string} userText - The text provided by the user
   * @returns {Promise<Object>} - The extracted JSON profile
   */
  async extractProfile(userText) {
    throw new Error('extractProfile must be implemented by the provider');
  }

  /**
   * R6.1 — general bounded completion, added so the AI Host does not need a
   * second AI stack. `extractProfile` above is unchanged and unaffected.
   *
   * Unlike extractProfile this NEVER throws: callers get a structured result and
   * can fail closed without a try/catch around every call site.
   *
   * @param {object} request
   * @param {string} request.system      system instructions (never user content)
   * @param {string} request.user        the bounded, sanitized payload
   * @param {number} request.maxTokens   hard output cap
   * @param {number} request.timeoutMs   hard request timeout
   * @param {string} [request.model]     server-chosen model; never client-supplied
   * @returns {Promise<{ok:boolean, text?:string, errorKind?:string, error?:string, latencyMs:number}>}
   *          errorKind is one of: 'transient' | 'permanent'
   */
  async complete(request) { // eslint-disable-line no-unused-vars
    return { ok: false, errorKind: 'permanent', error: 'complete() not implemented by provider', latencyMs: 0 };
  }
}

module.exports = AiProvider;
