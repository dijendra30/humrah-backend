// services/engagement/ai/providers/httpErrors.js
// Shared, credential-free classification of provider HTTP failures.
//
// An axios error carries the request config (headers with the API key). Nothing here
// ever returns, logs or stores that object: only an outcome kind, a short code,
// the HTTP status and a retry hint leave this file.
'use strict';

const KINDS = Object.freeze(['TRANSIENT', 'RATE_LIMIT', 'QUOTA', 'AUTH', 'PERMANENT', 'MALFORMED']);

// "30s", "1.5s" (Gemini RetryInfo) or a Retry-After header in seconds.
function parseRetryMs(value) {
  if (value === undefined || value === null) return null;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*s?$/);
  if (!m) return null;
  const ms = Math.round(Number(m[1]) * 1000);
  return Number.isFinite(ms) && ms >= 0 && ms <= 24 * 3600 * 1000 ? ms : null;
}

// Short, safe code from a provider error body: [A-Z_]{..} words only, no free text.
function safeCode(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^[A-Za-z_][A-Za-z0-9_.\-]{0,59}$/);
  return m ? m[0] : null;
}

const QUOTA_HINT = /quota|per day|daily|billing|exceeded your current|tokens per day|requests per day|RPD|TPD/i;
const AUTH_HINT = /api[_ ]?key|API_KEY_INVALID|unauthenticated|permission|invalid_api_key|forbidden/i;

/**
 * @param {Error} err  axios error
 * @param {object} extract  provider-specific readers { code(body), message(body), retryMs(body, headers) }
 */
function classifyAxiosError(err, extract) {
  if (!err || !err.response) {
    const c = err && err.code;
    if (c === 'ECONNABORTED' || c === 'ETIMEDOUT' || (err && /timeout/i.test(err.message || ''))) return { kind: 'TRANSIENT', code: 'TIMEOUT', httpStatus: null };
    return { kind: 'TRANSIENT', code: 'NETWORK_ERROR', httpStatus: null };
  }
  const status = err.response.status;
  const body = err.response.data;
  const headers = err.response.headers || {};
  let message = '';
  try { message = String(extract.message(body) || ''); } catch (_) { message = ''; }
  let code = null;
  try { code = safeCode(extract.code(body)); } catch (_) { code = null; }
  let retryMs = null;
  try { retryMs = extract.retryMs(body, headers); } catch (_) { retryMs = null; }
  if (retryMs === null) retryMs = parseRetryMs(headers['retry-after']);

  if (status === 429) {
    if (QUOTA_HINT.test(message)) return { kind: 'QUOTA', code: code || 'QUOTA_EXHAUSTED', httpStatus: status, retryMs };
    return { kind: 'RATE_LIMIT', code: code || 'RATE_LIMITED', httpStatus: status, retryMs };
  }
  if (status === 401 || status === 403) return { kind: 'AUTH', code: code || `HTTP_${status}`, httpStatus: status };
  if (status === 400 && AUTH_HINT.test(`${message} ${code || ''}`)) return { kind: 'AUTH', code: code || 'INVALID_CREDENTIALS', httpStatus: status };
  if (status === 408 || status >= 500) return { kind: 'TRANSIENT', code: code || `HTTP_${status}`, httpStatus: status };
  return { kind: 'PERMANENT', code: code || `HTTP_${status}`, httpStatus: status };
}

module.exports = { KINDS, classifyAxiosError, parseRetryMs, safeCode };
