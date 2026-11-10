// services/invitations/inviteToken.js — invitation link tokens.
//
// 24 random bytes from the OS CSPRNG → 32 base64url characters (192 bits).
// Not derived from any ObjectId, time or user data. Only the SHA-256 hash is stored.
'use strict';

const crypto = require('crypto');

const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** True only for a string shaped exactly like a token this module issues. */
function isWellFormed(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { newToken, isWellFormed, hashToken, TOKEN_PATTERN };
