// services/engagement/log.js
// Structured, privacy-safe log lines for the engagement worker:
//   [ENGAGEMENT] {"event":"batch_done","users":100,"queued":3,...}
// Only counts, reason codes, categories and internal notification ids are logged.
// Never: user ids, names, tokens, coordinates, titles/bodies, Firebase credentials.
'use strict';

const FORBIDDEN_KEYS = new Set(['userId', 'token', 'tokens', 'fcmToken', 'lat', 'lng', 'coordinates', 'email', 'name', 'title', 'body', 'privateKey']);

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) ? clean(v) : v;
  }
  return out;
}

const line = (event, fields) => `[ENGAGEMENT] ${JSON.stringify({ event, ...clean(fields) })}`;

module.exports = {
  info: (event, fields) => console.log(line(event, fields)),
  warn: (event, fields) => console.warn(line(event, fields)),
  error: (event, fields) => console.error(line(event, fields)),
  // Error → short tag: name and Mongo/Firebase code only (messages can hold data).
  errTag: err => (err ? `${err.name || 'Error'}${err.code ? ':' + err.code : ''}` : 'Error'),
  _internal: { clean },
};
