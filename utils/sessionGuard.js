// utils/sessionGuard.js
// One signed-in phone per account. Decides whether a verified JWT still belongs to the
// account's current session. The REST middleware and every socket namespace use this, so
// a replaced phone is turned away everywhere at once.
'use strict';

const jwt = require('jsonwebtoken');

const SESSION_FIELDS  = '+activeSessionId +activeSessionStartedAt';
const DASHBOARD_SCOPE = 'admin-dashboard';

/**
 * Null when the token is current, otherwise why it is not:
 *   TOKEN_REVOKED    tokenVersion moved on (logout-all, password change or reset)
 *   SESSION_REPLACED another app login, or a logout, ended this token's session
 */
function sessionRejection(decoded, user) {
  if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) return 'TOKEN_REVOKED';

  // The web admin dashboard is its own session, separate from the phone.
  if (decoded.scope === DASHBOARD_SCOPE) return null;

  if (decoded.sid) return decoded.sid === user.activeSessionId ? null : 'SESSION_REPLACED';

  // A token issued before sessions existed stays valid until the account next signs in.
  const startedAt = user.activeSessionStartedAt ? new Date(user.activeSessionStartedAt).getTime() : 0;
  if (startedAt && (decoded.iat || 0) * 1000 < startedAt) return 'SESSION_REPLACED';
  return null;
}

/**
 * Socket handshakes: verify the JWT, load the user, apply sessionRejection.
 * Resolves { decoded, user }; rejects with the "Authentication error: …" messages
 * the clients already handle. `select` adds user fields the caller needs.
 */
async function verifySocketSession(rawToken, User, select = '') {
  const token = typeof rawToken === 'string' && rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;
  if (!token || typeof token !== 'string') throw new Error('Authentication error: No token provided');

  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Authentication error: Server misconfiguration');

  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new Error('Authentication error: Token expired');
    throw new Error('Authentication error: Invalid token');
  }

  const user = await User.findById(decoded.userId)
    .select(`tokenVersion ${SESSION_FIELDS} ${select}`.trim())
    .lean();
  if (!user) throw new Error('Authentication error: User not found');

  const reason = sessionRejection(decoded, user);
  if (reason === 'SESSION_REPLACED') throw new Error('Authentication error: Session replaced');
  if (reason) throw new Error('Authentication error: Session expired');
  return { decoded, user };
}

/** Records whose socket this is, so a takeover can find and disconnect the old phone. */
function tagSocket(socket, decoded) {
  socket.data = socket.data || {};
  socket.data.authUserId = String(decoded.userId);
  socket.data.sid        = decoded.sid || null;
  socket.data.scope      = decoded.scope || null;
}

module.exports = { sessionRejection, verifySocketSession, tagSocket, SESSION_FIELDS, DASHBOARD_SCOPE };
