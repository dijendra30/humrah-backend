// sockets/sportsSocket.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 1A realtime plan events on a DEDICATED namespace.
//
//   namespace  /sports
//   plan room  sports:{planId}
//   user room  user:{userId}   (per-namespace; used to pull a user out of a room)
//
// Why a separate namespace. Movie Hangout's events live on the DEFAULT namespace
// under generic names — typing, markRead, reactToMessage, pinMessage — each hard-
// wired to the `movie:` room prefix. Gaming uses its own /gaming namespace. Events
// on /sports cannot reach a Movie or Gaming listener whatever they are called, so
// there is no collision to manage.
//
// Deliberately NOT copied from /gaming (sockets/sessionSocket.js):
//   - its JWT fallback secret. /gaming verifies with
//     `process.env.JWT_SECRET || "fallback_secret_change_in_production"`. Here a
//     missing JWT_SECRET refuses the connection, as middleware/auth.js does.
//   - its unchecked room join. /gaming's join_session_room lets any authenticated
//     user into any session room. Here membership is re-read from the database on
//     every join, like the Humrah Rooms socket's join_room.
//
// REST is the only way to change a plan. These events only tell people who are
// already looking at a plan that it changed.
// -----------------------------------------------------------------------------
'use strict';

const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

// Required directly rather than looked up with mongoose.model(name): a lookup only
// works once something else has registered the schema, and this file is loaded by
// server.js before the sports routes are mounted.
const User       = require('../models/User');
const SportsPlan = require('../models/SportsPlan');

const NAMESPACE = '/sports';
const planRoom  = planId => `sports:${planId}`;
const userRoom  = userId => `user:${userId}`;

const isValidId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);

/**
 * Makes the same allow/deny decision middleware/auth.js makes for REST, so a user
 * REST would refuse cannot hold a socket open instead:
 *   - JWT_SECRET must be set (no fallback)
 *   - the user must still exist
 *   - the token's version must match the user's (logout-all revokes it)
 *   - status, if set, must be ACTIVE; not suspended (unless the suspension has
 *     lapsed); not banned
 *
 * Unlike REST it never writes. REST auto-lifts a lapsed suspension and stamps
 * lastActive; a socket handshake just lets a lapsed suspension through and leaves
 * the bookkeeping to the next REST call.
 */
async function authenticateSocket(socket, next) {
  try {
    const raw   = socket.handshake?.auth?.token || '';
    const token = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication error: No token provided'));
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('[SPORTS_SOCKET] JWT_SECRET is not set — refusing connection.');
      return next(new Error('Authentication error: Server misconfiguration'));
    }

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (_) {
      return next(new Error('Authentication error: Invalid token'));
    }
    if (!decoded || !isValidId(String(decoded.userId || ''))) {
      return next(new Error('Authentication error: Invalid token'));
    }

    const user = await User.findById(decoded.userId)
      .select('status tokenVersion suspensionInfo banInfo')
      .lean();
    if (!user) return next(new Error('Authentication error: User not found'));

    if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return next(new Error('Authentication error: Session expired'));
    }
    if (user.status && user.status !== 'ACTIVE') {
      return next(new Error('Authentication error: Account not active'));
    }
    const susp = user.suspensionInfo;
    if (susp?.isSuspended && !(susp.suspendedUntil && new Date() > new Date(susp.suspendedUntil))) {
      return next(new Error('Authentication error: Account suspended'));
    }
    if (user.banInfo?.isBanned) {
      return next(new Error('Authentication error: Account banned'));
    }

    socket.data.userId = String(user._id);
    return next();
  } catch (err) {
    console.error('[SPORTS_SOCKET] auth error:', err.message);
    return next(new Error('Authentication error'));
  }
}

function initSportsSocket(io) {
  // Registering the connection handler twice would double every event — the same
  // guard the Humrah Rooms socket uses.
  if (io.__sportsSocketInit) return io.of(NAMESPACE);
  io.__sportsSocketInit = true;

  const ns = io.of(NAMESPACE);
  ns.use(authenticateSocket);

  ns.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(userRoom(userId));

    socket.on('join_plan_room', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const planId = payload && typeof payload.planId === 'string' ? payload.planId : null;
      if (!isValidId(planId)) return reply({ ok: false, error: 'invalid_plan_id' });

      try {
        // Membership is re-read from the database on every join, never trusted from
        // the client. The creator is always in playersJoined, so this one check
        // covers both the host and the players.
        const member = await SportsPlan.exists({
          _id:           planId,
          playersJoined: new mongoose.Types.ObjectId(userId),
        });
        if (!member) {
          console.warn(`[SPORTS_SOCKET] join_plan_room DENIED userId=${userId} planId=${planId}`);
          return reply({ ok: false, error: 'not_a_member' });
        }
        socket.join(planRoom(planId));
        return reply({ ok: true, room: planRoom(planId) });
      } catch (err) {
        console.error('[SPORTS_SOCKET] join_plan_room error:', err.message);
        return reply({ ok: false, error: 'server_error' });
      }
    });

    socket.on('leave_plan_room', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const planId = payload && typeof payload.planId === 'string' ? payload.planId : null;
      if (!isValidId(planId)) return reply({ ok: false, error: 'invalid_plan_id' });
      socket.leave(planRoom(planId));
      return reply({ ok: true });
    });
  });

  return ns;
}

// ── Emit helpers — called by routes/sportsPlanRoutes.js after a REST change ────
//
// Payloads carry counts and the acting user's public first name, never the
// participant list — anyone who needs that is a member and can GET the plan.

function snapshot(plan) {
  return {
    planId:      plan.id,
    playerCount: plan.playerCount,
    playerLimit: plan.playerLimit,
    spotsLeft:   plan.spotsLeft,
    isFull:      plan.isFull,
    cardStatus:  plan.cardStatus,
    at:          new Date().toISOString(),
  };
}

function emitPlanJoined(io, plan, actor) {
  if (!io || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('plan_joined', {
    ...snapshot(plan),
    userId:    String(actor._id),
    firstName: actor.firstName || 'Someone',
  });
}

function emitPlanLeft(io, plan, actor) {
  if (!io || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('plan_left', {
    ...snapshot(plan),
    userId:    String(actor._id),
    firstName: actor.firstName || 'Someone',
  });
}

function emitPlanCancelled(io, plan) {
  if (!io || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('plan_cancelled', {
    ...snapshot(plan),
    chatStatus: plan.chatStatus,
  });
}

/**
 * For changes to a plan's details. Phase 1A has no edit endpoint, so nothing calls
 * this yet; it is defined so the event name is fixed before a client depends on it.
 */
function emitPlanUpdated(io, plan) {
  if (!io || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('plan_updated', snapshot(plan));
}

/**
 * Takes every socket this user has open out of the plan room. Called after a user
 * leaves, so a former participant stops receiving that plan's events immediately
 * rather than whenever their client happens to disconnect.
 */
function evictUserFromPlanRoom(io, planId, userId) {
  if (!io || !planId || !userId) return;
  io.of(NAMESPACE).in(userRoom(String(userId))).socketsLeave(planRoom(String(planId)));
}

module.exports = {
  NAMESPACE,
  initSportsSocket,
  emitPlanJoined,
  emitPlanLeft,
  emitPlanCancelled,
  emitPlanUpdated,
  evictUserFromPlanRoom,
};
