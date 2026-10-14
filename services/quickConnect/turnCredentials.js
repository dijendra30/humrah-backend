// services/quickConnect/turnCredentials.js
// -----------------------------------------------------------------------------
// Short-lived TURN credentials in coturn's TURN REST format (use-auth-secret):
//   username   = "<unix expiry seconds>:<opaque id>"
//   credential = base64( HMAC-SHA1( TURN_SHARED_SECRET, username ) )
// This is the exact format accepted by turn.humrah.in (verified in Phase 3E).
//
// The opaque id is random per issue — no user id or session id reaches TURN logs.
// The secret never leaves this function: it is not returned, logged or stored.
//
// Expiry only stops NEW relay allocations; coturn keeps refreshing an allocation
// that already exists. Issuing a credential is not a call, and expiry is not call
// termination — the backend must end calls itself (services/quickConnect/sessions.js).
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');

/**
 * @param {{secret: string, ttlSeconds: number, uris: string[]}} cfg  from config.turnConfig()
 * @param {{now?: number}} [opts]
 * @returns {{ username: string, credential: string, ttlSeconds: number, expiresAt: string, uris: string[] }}
 */
function mintTurnCredentials(cfg, { now = Date.now() } = {}) {
  if (!cfg || typeof cfg.secret !== 'string' || !cfg.secret || !Array.isArray(cfg.uris) || cfg.uris.length === 0) {
    throw new Error('TURN is not configured');
  }
  const ttlSeconds = Math.floor(cfg.ttlSeconds);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('TURN is not configured');

  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiry}:${crypto.randomBytes(12).toString('base64url')}`;
  const credential = crypto.createHmac('sha1', cfg.secret).update(username).digest('base64');
  return {
    username,
    credential,
    ttlSeconds,
    expiresAt: new Date(expiry * 1000).toISOString(),
    uris: [...cfg.uris]
  };
}

module.exports = { mintTurnCredentials };
