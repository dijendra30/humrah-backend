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
//
// Phase 3 — group chat, in the SAME members-only room:
//   server → members   sports_message_created   one message (REST saved it first)
//                      sports_reaction_updated  a message's reaction counts
//                      sports_typing_started / sports_typing_stopped
//   client → server    sports_typing_start / sports_typing_stop  { planId }
// Messages are sent with REST, never over the socket. Typing is socket-only and
// never stored: allowed only for a socket that joined the room, only while the
// chat is open, rate-limited, and cleared after 5 s, on send, on leave, on
// eviction and on disconnect. Chat events are sent per socket, skipping anyone
// in a block pair with the person they are about (a snapshot taken when that
// socket joined the room).
//
// Chat enhancement — still server → members only, still after REST saved it:
//   sports_message_updated       { sessionId, messageId, text, editedAt }
//   sports_message_deleted       { sessionId, messageId, deletionType, deletedAt }
//                                — never the old text, never who deleted it
//   sports_poll_updated          { sessionId, poll } — counts, and each reader's
//                                own answer; never who voted what
//   session_participant_removed  the host removed someone (room)
//   sports_member_removed        to the removed person's OWN sockets, just
//                                before they are taken out of the room
//   sports_message_hidden        "delete for me", to the person's own sockets only
// A new reply's quote is adjusted per reader: a quote of someone the reader is
// in a block pair with is sent as unavailable, and one the reader hid for
// themselves as hidden — the same as a history read would show them.
// -----------------------------------------------------------------------------
'use strict';

const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

// Required directly rather than looked up with mongoose.model(name): a lookup only
// works once something else has registered the schema, and this file is loaded by
// server.js before the sports routes are mounted.
const User          = require('../models/User');
const SportsPlan    = require('../models/SportsPlan');
const SportsSession = require('../models/SportsSession');
const SportsHiddenMessage = require('../models/SportsHiddenMessage');

// Required lazily: these services emit through this module.
const planService = () => require('../services/sportsPlanService');
const chatService = () => require('../services/sportsChatService');

// Set by initSportsSocket, so services can emit chat events after a REST write.
let ioRef = null;

const TYPING_TTL_MS            = 5000;
const TYPING_BURSTS_PER_MINUTE = 20;
// `${socketId}|${planId}` → { timer, planId, sessionId, userId, firstName }
const typingBySocket = new Map();

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

// ── Phase 3 helpers ────────────────────────────────────────────────────────────

/**
 * Sends [event] to every socket in the plan room except those whose user is in a
 * block pair with [aboutUserId] (and, with skipUser, that user's own sockets).
 * [payload] may be a function of the socket, for what differs per reader.
 */
async function sendToRoom(planId, event, payload, aboutUserId, { skipUser = null, sockets = null } = {}) {
  if (!ioRef) return;
  const targets = sockets || await ioRef.of(NAMESPACE).in(planRoom(String(planId))).fetchSockets();
  for (const s of targets) {
    if (skipUser && String(s.data.userId) === String(skipUser)) continue;
    if (aboutUserId && s.data.blocked && s.data.blocked.has(String(aboutUserId))) continue;
    s.emit(event, typeof payload === 'function' ? payload(s) : payload);
  }
}

const typingPayload = t => ({ sessionId: t.sessionId, planId: t.planId, userId: t.userId, firstName: t.firstName });

function stopTyping(key) {
  const t = typingBySocket.get(key);
  if (!t) return;
  clearTimeout(t.timer);
  typingBySocket.delete(key);
  sendToRoom(t.planId, 'sports_typing_stopped', typingPayload(t), t.userId, { skipUser: t.userId })
    .catch(err => console.error('[SPORTS_SOCKET] typing stop broadcast failed:', err.message));
}

/** Stops [userId] typing in [planId] on every socket they have. */
function stopUserTyping(planId, userId) {
  for (const [key, t] of typingBySocket) {
    if (t.planId === String(planId) && t.userId === String(userId)) stopTyping(key);
  }
}

/** The session id when this plan's chat takes messages right now, else null. */
async function openChatFor(planId) {
  const [plan, session] = await Promise.all([
    SportsPlan.findById(planId).select('cardStatus startTime endTime playersJoined').lean(),
    SportsSession.findOne({ sportsPlanId: planId }).select('status lastMessageAt').lean(),
  ]);
  if (!plan || !session) return null;
  const open = chatService().chatStateOf(session, plan) === 'active' && (plan.playersJoined || []).length >= 2;
  return open ? String(session._id) : null;
}

/** At most TYPING_BURSTS_PER_MINUTE "started" broadcasts per socket. */
function allowTypingBurst(socket) {
  const now = Date.now();
  const w = socket.data.typingWindow;
  if (!w || now - w.start >= 60_000) {
    socket.data.typingWindow = { start: now, count: 1 };
    return true;
  }
  w.count += 1;
  return w.count <= TYPING_BURSTS_PER_MINUTE;
}

function initSportsSocket(io) {
  // Registering the connection handler twice would double every event — the same
  // guard the Humrah Rooms socket uses.
  if (io.__sportsSocketInit) return io.of(NAMESPACE);
  io.__sportsSocketInit = true;
  ioRef = io;

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
        // Phase 3: who this socket must not hear from (both directions), and the
        // name its typing shows under. Refreshed on every join.
        const me = await User.findById(userId).select('firstName blockedUsers').lean();
        socket.data.firstName = (me && me.firstName) || 'Someone';
        socket.data.blocked = new Set(
          me ? (await planService()._internal.blockedCounterparts(me)).map(String) : [],
        );
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
      stopTyping(`${socket.id}|${planId}`);
      socket.leave(planRoom(planId));
      return reply({ ok: true });
    });

    // ── Typing (Phase 3) ──────────────────────────────────────────────────────
    // "started" is broadcast once per burst; repeats only extend the 5 s timer.
    socket.on('sports_typing_start', async (payload) => {
      const planId = payload && typeof payload.planId === 'string' ? payload.planId : null;
      if (!isValidId(planId) || !socket.rooms.has(planRoom(planId))) return;
      const key = `${socket.id}|${planId}`;
      const current = typingBySocket.get(key);
      if (current) {
        clearTimeout(current.timer);
        current.timer = setTimeout(() => stopTyping(key), TYPING_TTL_MS);
        return;
      }
      if (!allowTypingBurst(socket)) return;
      try {
        const sessionId = await openChatFor(planId);
        if (!sessionId || typingBySocket.has(key) || !socket.connected) return;
        const t = { planId, sessionId, userId, firstName: socket.data.firstName || 'Someone' };
        t.timer = setTimeout(() => stopTyping(key), TYPING_TTL_MS);
        typingBySocket.set(key, t);
        await sendToRoom(planId, 'sports_typing_started', typingPayload(t), userId, { skipUser: userId });
      } catch (err) {
        console.error('[SPORTS_SOCKET] typing start error:', err.message);
      }
    });

    socket.on('sports_typing_stop', (payload) => {
      const planId = payload && typeof payload.planId === 'string' ? payload.planId : null;
      if (!isValidId(planId)) return;
      stopTyping(`${socket.id}|${planId}`);
    });

    // A dropped socket must never stay "typing".
    socket.on('disconnect', () => {
      for (const key of [...typingBySocket.keys()]) {
        if (key.startsWith(`${socket.id}|`)) stopTyping(key);
      }
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

// ── Session events (Phase 2A) ──────────────────────────────────────────────────
//
// A session's members are exactly its plan's members, so session events go to the
// same members-only plan room — the same database check guards both. Like the
// plan events they carry counts and the actor's first name, never the member
// list; a client that needs more re-reads GET /sessions/:sessionId. After a
// reconnect a client should re-read rather than trust what it may have missed.

function sessionSnapshot(session, plan) {
  return {
    sessionId:   session.id,
    planId:      plan.id,
    status:      session.status,
    memberCount: plan.playerCount,
    playerLimit: plan.playerLimit,
    at:          new Date().toISOString(),
  };
}

function emitSessionParticipantJoined(io, session, plan, actor) {
  if (!io || !session || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('session_participant_joined', {
    ...sessionSnapshot(session, plan),
    userId:    String(actor._id),
    firstName: actor.firstName || 'Someone',
  });
}

function emitSessionParticipantLeft(io, session, plan, actor) {
  if (!io || !session || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('session_participant_left', {
    ...sessionSnapshot(session, plan),
    userId:    String(actor._id),
    firstName: actor.firstName || 'Someone',
  });
}

function emitSessionCancelled(io, session, plan) {
  if (!io || !session || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('session_cancelled', {
    ...sessionSnapshot(session, plan),
    status: 'cancelled',
  });
}

/**
 * Takes every socket this user has open out of the plan room. Called after a user
 * leaves, so a former participant stops receiving that plan's events immediately
 * rather than whenever their client happens to disconnect.
 */
function evictUserFromPlanRoom(io, planId, userId) {
  if (!io || !planId || !userId) return;
  stopUserTyping(planId, userId);
  io.of(NAMESPACE).in(userRoom(String(userId))).socketsLeave(planRoom(String(planId)));
}

// ── Chat events (Phase 3) — called by services/sportsChatService.js ───────────

/**
 * A message REST has already saved, to the plan's members (including the sender's
 * other devices; clients de-duplicate by id). Sending also ends the sender's
 * typing indicator. [aboutUserId]: the sender, or who a system message is about.
 * A reply's quote is adjusted per reader (see the header).
 */
function emitSportsMessage(planId, message, aboutUserId) {
  if (!ioRef || !planId || !message) return;
  if (message.type === 'TEXT' && aboutUserId) stopUserTyping(planId, aboutUserId);
  const base = { planId: String(planId), message };
  const quote = message.replyTo && message.replyTo.text != null ? message.replyTo : null;
  (async () => {
    if (!quote) return sendToRoom(planId, 'sports_message_created', base, aboutUserId);
    const sockets = await ioRef.of(NAMESPACE).in(planRoom(String(planId))).fetchSockets();
    const readers = [...new Set(sockets.map(s => String(s.data.userId)))];
    const hid = new Set((await SportsHiddenMessage.find({ messageId: quote.messageId, userId: { $in: readers } })
      .select('userId').lean()).map(r => String(r.userId)));
    const withQuote = extra => ({ ...base, message: { ...message, replyTo: { ...quote, text: null, ...extra } } });
    return sendToRoom(planId, 'sports_message_created', s => {
      if (s.data.blocked && s.data.blocked.has(String(quote.senderId))) {
        return withQuote({ senderId: null, senderFirstName: null, unavailable: true });
      }
      if (hid.has(String(s.data.userId))) return withQuote({ hiddenForYou: true });
      return base;
    }, aboutUserId, { sockets });
  })().catch(err => console.error('[SPORTS_SOCKET] message broadcast failed:', err.message));
}

/** An edit: the new text and when. The author's own other devices get it too. */
function emitSportsMessageUpdated(planId, payload, authorId) {
  if (!ioRef || !planId || !payload) return;
  sendToRoom(planId, 'sports_message_updated', { planId: String(planId), ...payload }, authorId)
    .catch(err => console.error('[SPORTS_SOCKET] edit broadcast failed:', err.message));
}

/** A delete for everyone: which message and how — never its text or who did it. */
function emitSportsMessageDeleted(planId, payload) {
  if (!ioRef || !planId || !payload) return;
  sendToRoom(planId, 'sports_message_deleted', { planId: String(planId), ...payload }, null)
    .catch(err => console.error('[SPORTS_SOCKET] delete broadcast failed:', err.message));
}

/**
 * The attendance check's counts. [pollFor](userId) formats it for one reader, so
 * each gets their own answer and nobody learns anyone else's.
 */
function emitSportsPoll(planId, sessionId, pollFor) {
  if (!ioRef || !planId || typeof pollFor !== 'function') return;
  sendToRoom(planId, 'sports_poll_updated', s => ({
    planId:    String(planId),
    sessionId: String(sessionId),
    poll:      pollFor(String(s.data.userId)),
  }), null).catch(err => console.error('[SPORTS_SOCKET] poll broadcast failed:', err.message));
}

/** To one user's own sockets on this namespace only (e.g. "delete for me"). */
function emitToUser(userId, event, payload) {
  if (!ioRef || !userId) return;
  ioRef.of(NAMESPACE).to(userRoom(String(userId))).emit(event, payload);
}

/**
 * The host removed [userId]: their own open screens are told first (so the chat
 * can say so and close the composer), then every socket they have leaves the
 * room — before the "was removed" message is posted, which they never receive.
 */
function removeUserFromChat(planId, sessionId, userId) {
  if (!ioRef || !planId || !userId) return;
  emitToUser(userId, 'sports_member_removed', {
    planId:    String(planId),
    sessionId: String(sessionId),
    userId:    String(userId),
  });
  evictUserFromPlanRoom(ioRef, planId, userId);
}

/** To the members who remain: someone was removed (a cue to re-read, like a leave). */
function emitSessionParticipantRemoved(io, session, plan, userId) {
  if (!io || !session || !plan) return;
  io.of(NAMESPACE).to(planRoom(plan.id)).emit('session_participant_removed', {
    ...sessionSnapshot(session, plan),
    userId: String(userId),
  });
}

/** A message's reaction counts; clients work out their own "reacted" from userIds. */
function emitSportsReaction(planId, payload) {
  if (!ioRef || !planId || !payload) return;
  sendToRoom(planId, 'sports_reaction_updated', { planId: String(planId), ...payload }, null)
    .catch(err => console.error('[SPORTS_SOCKET] reaction broadcast failed:', err.message));
}

module.exports = {
  NAMESPACE,
  initSportsSocket,
  emitPlanJoined,
  emitPlanLeft,
  emitPlanCancelled,
  emitPlanUpdated,
  evictUserFromPlanRoom,
  emitSessionParticipantJoined,
  emitSessionParticipantLeft,
  emitSessionCancelled,
  emitSportsMessage,
  emitSportsReaction,
  emitSportsMessageUpdated,
  emitSportsMessageDeleted,
  emitSportsPoll,
  emitToUser,
  removeUserFromChat,
  emitSessionParticipantRemoved,
  // For tests.
  _internal: { typingBySocket, TYPING_TTL_MS },
};
