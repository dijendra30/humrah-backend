/**
 * routes/gamingRoutes.js
 * Mounted at /api/session in server.js
 * Auth is handled by server.js middleware — no per-route auth needed.
 *
 * New in this version:
 *   - chatExpiresAt = startTime + 3 hours  (was 1h)
 *   - /leave     — player leaves session
 *   - /start-early, /cancel  — host powers
 *   - /kick, /mute           — host moderation
 *   - /pin-message           — host pins a message
 *   - /react                 — any member reacts to a message
 *   - /report                — report a user
 *   - Rate limit: 1 message/sec per user
 *
 * ── DUAL-STATUS CHANGES ──────────────────────────────────────
 *   cardStatus  → controls FEED CARD only
 *     'waiting' | 'full' | 'started' | 'expired' | 'cancelled'
 *   chatStatus  → controls CHAT ACCESS only (independent of card)
 *     'open' | 'closed'
 *
 *   Expiry job now runs TWO independent steps:
 *     Step 1: cardExpiresAt passed → cardStatus = 'expired'   (chatStatus untouched)
 *     Step 2: chatExpiresAt passed → chatStatus = 'closed'    (cardStatus untouched)
 *
 *   isChatOpen() reads chatStatus ONLY — card expiry can NEVER kill the chat.
 */

const express       = require("express");
const router        = express.Router();
const GamingSession = require("../models/GamingSession");
const User          = require("../models/User");
const {
  emitSessionCreated,
  emitPlayerJoined,
  emitPlayerLeft,
  emitSessionExpired,
  emitPlayerKicked,
  emitPlayerMuted,
  emitSessionStarted,
  emitSessionCancelled,
  emitPinnedMessage,
  emitNewReaction,
  emitNewMessage,
} = require("../sockets/sessionSocket");
const { sendGamingPush } = require("../utils/gamingPush");

// ── Constants ─────────────────────────────────────────────────
const THREE_HOURS_MS    = 3 * 60 * 60 * 1000;
const FIVE_MIN_MS       = 5 * 60 * 1000;
const TWO_HOURS_MS      = 2 * 60 * 60 * 1000;
const MSG_RATE_LIMIT_MS = 1000;   // 1 msg/sec per user

// Boost notification limits (§11)
const BOOST_LIMITS = { normal: 50, boost20: 200, boost50: 1000 };

// ── §10: Daily notification rate-limiter (max 2 per user per day) ──
const _dailyNotifCount = new Map();
function _dayKey(userId) {
  const d = new Date();
  return `${userId}:${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function canNotifyToday(userId) {
  return (_dailyNotifCount.get(_dayKey(userId)) || 0) < 2;
}
function markNotified(userId) {
  const k = _dayKey(userId);
  _dailyNotifCount.set(k, (_dailyNotifCount.get(k) || 0) + 1);
}
// Purge stale keys every hour to prevent unbounded memory growth
setInterval(() => {
  const todayDate = _dayKey('').split(':')[1];
  for (const k of _dailyNotifCount.keys()) {
    if (!k.endsWith(todayDate)) _dailyNotifCount.delete(k);
  }
}, 60 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────

function isMember(session, userId) {
  return session.creatorId.toString() === userId ||
         session.playersJoined.map(String).includes(userId);
}
function isHost(session, userId) {
  return session.creatorId.toString() === userId;
}
function isMuted(session, userId) {
  return session.mutedPlayers.some(
    m => m.userId.toString() === userId && m.mutedUntil > new Date()
  );
}

// ✅ DUAL-STATUS: isChatOpen reads chatStatus ONLY.
// Card expiry (cardStatus='expired') can NEVER close the chat.
function isChatOpen(session) {
  const cs = session.chatStatus || 'open';   // default 'open' for old docs without field
  return cs === 'open' &&
         Date.now() < new Date(session.chatExpiresAt).getTime();
}

// ✅ DUAL-STATUS: isCardActive reads cardStatus ONLY.
function isCardActive(session) {
  const cs = session.cardStatus || 'waiting';  // default for old docs
  return ['waiting', 'full', 'started'].includes(cs);
}

function formatSession(s) {
  const pinned = s.pinnedMessageId
    ? s.messages.find(m => m._id.toString() === s.pinnedMessageId?.toString())
    : null;
  return {
    sessionId:          s._id.toString(),
    creatorId:          s.creatorId.toString(),
    creatorUsername:    s.creatorUsername,
    creatorCity:        s.city,
    gameType:           s.gameType,
    customGameName:     s.customGameName || null,
    playersNeeded:      s.playersNeeded,
    playersJoined:      (s.playersJoined || []).map(String),
    kickedPlayers:      (s.kickedPlayers || []).map(String),
    mutedPlayers:       (s.mutedPlayers || []).map(m => ({
      userId: m.userId.toString(), mutedUntil: m.mutedUntil.toISOString(),
    })),
    notInterestedUsers: (s.notInterestedUsers || []).map(String),
    boostLevel:         s.boostLevel || 'normal',
    likedBy:            (s.likedBy || []).map(String),
    startTime:          s.startTime.toISOString(),
    chatExpiresAt:      s.chatExpiresAt.toISOString(),
    cardExpiresAt:      s.cardExpiresAt?.toISOString() || null,
    createdAt:          s.createdAt.toISOString(),
    // ✅ Both status fields returned to Android
    cardStatus:         s.cardStatus  || 'waiting',
    chatStatus:         s.chatStatus  || 'open',
    status:             s.status,                   // legacy — kept for old clients
    optionalMessage:    s.optionalMessage || null,
    pinnedMessage:      pinned ? formatMsg(pinned, s._id.toString()) : null,
  };
}
function formatMsg(m, sessionId) {
  return {
    messageId:      m._id.toString(),
    sessionId,
    senderId:       m.senderId.toString(),
    senderUsername: m.senderUsername,
    senderAvatar:   m.senderAvatar || null,
    text:           m.text,
    sentAt:         m.sentAt.toISOString(),
    isPinned:       !!m.isPinned,
    isSystemMsg:    !!m.isSystemMsg,
    reactions:      (m.reactions || []).map(r => ({
      userId: r.userId.toString(), emoji: r.emoji,
    })),
  };
}
function displayName(user) {
  return `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User";
}
function resolveCity(req, bodyCity) {
  return (bodyCity || req.user?.questionnaire?.city || req.user?.city || "Unknown").trim();
}

// ═══════════════════════════════════════════════════════════════
//  SESSION ROUTES
// ═══════════════════════════════════════════════════════════════

// ── GET /sessions/can-create  (MUST be before /:id routes) ────
router.get("/sessions/can-create", async (req, res) => {
  try {
    const recent = await GamingSession.findOne({
      creatorId:  req.user._id,
      // ✅ Use cardStatus — not old status field
      cardStatus: { $nin: ["expired", "cancelled"] },
      createdAt:  { $gte: new Date(Date.now() - TWO_HOURS_MS) },
    }).sort({ createdAt: -1 });
    if (!recent) return res.json({ canCreate: true, nextAllowedAt: null });
    const next = new Date(recent.createdAt.getTime() + TWO_HOURS_MS);
    if (Date.now() >= next.getTime()) return res.json({ canCreate: true, nextAllowedAt: null });
    res.json({ canCreate: false, nextAllowedAt: next.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/check-existing  — §3 ──────────────────────
// Must be declared BEFORE /:id routes
router.post("/sessions/check-existing", async (req, res) => {
  try {
    const { gameType } = req.body;
    if (!gameType) return res.status(400).json({ error: "gameType required" });
    const fiveMinutesAgo = new Date(Date.now() - FIVE_MIN_MS);
    const existing = await GamingSession.findOne({
      gameType,
      cardStatus:         "waiting",
      createdAt:          { $gte: fiveMinutesAgo },
      creatorId:          { $ne: req.user._id },
      playersJoined:      { $nin: [req.user._id] },
      notInterestedUsers: { $nin: [req.user._id] }
    });
    if (existing) {
      return res.json({
        sessionExists:  true,
        sessionId:      existing._id.toString(),
        playersWaiting: existing.playersJoined.length + 1
      });
    }
    res.json({ sessionExists: false, sessionId: null, playersWaiting: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /sessions ─────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  try {
    const uid  = req.user._id;
    const city = resolveCity(req, req.query.city);

    // ── Query 1: Active feed cards (visible in community) ──────
    const feedSessions = await GamingSession.find({
      city,
      // ✅ cardStatus filter — never chatStatus
      cardStatus:         { $in: ["waiting", "full", "started"] },
      notInterestedUsers: { $nin: [uid] },
      dismissedBy:        { $nin: [uid] },
      kickedPlayers:      { $nin: [uid] },
    }).sort({ startTime: 1 }).limit(20);

    // ── Query 2: User's own sessions where chat is still open ──
    // Card may be expired but chat runs for 3h independently
    const mySessions = await GamingSession.find({
      // ✅ chatStatus filter — never cardStatus
      chatStatus:    "open",
      chatExpiresAt: { $gt: new Date() },
      $or: [{ creatorId: uid }, { playersJoined: uid }],
    });

    // Merge, deduplicate
    const seen = new Set();
    const result = [];
    for (const s of [...feedSessions, ...mySessions]) {
      const id = s._id.toString();
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(formatSession(s));
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions ────────────────────────────────────────────
router.post("/sessions", async (req, res) => {
  try {
    const { gameType, customGameName, playersNeeded, startTime, optionalMessage, city, boostLevel = "normal" } = req.body;
    if (!gameType)      return res.status(400).json({ error: "gameType is required" });
    if (!startTime)     return res.status(400).json({ error: "startTime is required" });
    if (!playersNeeded) return res.status(400).json({ error: "playersNeeded is required" });

    const start = new Date(startTime);
    if (isNaN(start.getTime())) return res.status(400).json({ error: "startTime is not a valid date" });

    const bufferMs = 60 * 1000;
    if (start < new Date(Date.now() - bufferMs))
      return res.status(400).json({ error: "Start time must be in the future" });
    if (start - Date.now() > THREE_HOURS_MS + bufferMs)
      return res.status(400).json({ error: "Session must start within 3 hours" });

    if (gameType === "OTHER") {
      const name = (customGameName || "").trim();
      if (name.length < 2 || name.length > 30)
        return res.status(400).json({ error: "Custom game name must be 2–30 characters" });
    }

    // Anti-spam: block if user has an active card session
    const existing = await GamingSession.findOne({
      creatorId:  req.user._id,
      cardStatus: { $in: ["waiting", "full", "started"] },
    });
    if (existing) return res.status(409).json({
      error: "You already have an active session",
      nextAllowedAt: new Date(existing.createdAt.getTime() + TWO_HOURS_MS).toISOString(),
    });

    const sessionCity   = resolveCity(req, city);
    const chatExpiresAt = new Date(start.getTime() + THREE_HOURS_MS);

    const session = await GamingSession.create({
      creatorId:       req.user._id,
      creatorUsername: displayName(req.user),
      city:            sessionCity,
      gameType:        gameType.trim(),
      customGameName:  gameType === "OTHER" ? (customGameName || "").trim() : null,
      playersNeeded:   Number(playersNeeded),
      startTime:       start,
      chatExpiresAt,
      optionalMessage: optionalMessage?.trim() || null,
      boostLevel:      (boostLevel || "normal").toLowerCase(),
      // ✅ Set both status fields independently on create
      cardStatus:      "waiting",
      chatStatus:      "open",
      status:          "waiting_for_players",   // legacy field kept in sync
    });

    console.log(`[gaming] Created ${session._id} by ${req.user._id} in ${sessionCity}`);
    const io = req.app.get("io");
    if (io) emitSessionCreated(io, session.city, formatSession(session));

    // §10, §11: notify eligible players (async, fire-and-forget)
    sendNewSessionNotifications(session, req.user._id).catch(console.error);

    res.status(201).json(formatSession(session));
  } catch (e) {
    console.error("[gaming POST /sessions]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sessions/:id/join ───────────────────────────────────
router.post("/sessions/:id/join", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    // ✅ Join check uses cardStatus only — chat status irrelevant here
    if (!isCardActive(session))
      return res.status(410).json({ error: "Session is no longer accepting players" });

    const uid = req.user._id.toString();
    if (isHost(session, uid))    return res.status(400).json({ error: "You created this session" });
    if (session.kickedPlayers.map(String).includes(uid))
      return res.status(403).json({ error: "You were removed from this session" });
    if (session.playersJoined.map(String).includes(uid))
      return res.status(400).json({ error: "Already joined" });
    if (session.playersJoined.length + 1 >= session.playersNeeded)
      return res.status(409).json({ error: "Session is full" });

    session.playersJoined.push(req.user._id);
    // ✅ Update cardStatus when full — chatStatus untouched
    if (session.playersJoined.length + 1 >= session.playersNeeded) {
      session.cardStatus = "full";
      session.status     = "full";
    }

    const name = displayName(req.user);
    session.messages.push({
      senderId: req.user._id, senderUsername: name,
      text: `${name} joined the squad 🎮`, isSystemMsg: true,
    });
    await session.save();

    const io = req.app.get("io");
    if (io) emitPlayerJoined(io, session);

    sendGamingPush({
      recipientId:  session.creatorId.toString(),
      title:        `${session.gameType} Session`,
      body:         `${name} joined your ${session.gameType} session! 🎮`,
      data:         { type: "PLAYER_JOINED", sessionId: session._id.toString() },
    }).catch(err => console.error("[gamingPush] join notification failed:", err));

    res.json(formatSession(session));

    // ── Activity: JOIN_GAMING ─────────────────────────────────
    const { createOrAggregateActivity } = require("../controllers/activityController");
    createOrAggregateActivity({
      userId:     session.creatorId.toString(),
      actorId:    req.user._id.toString(),
      type:       "JOIN_GAMING",
      entityType: "gaming_session",
      entityId:   session._id,
      message:    `${name} joined your gaming session`,
    }).catch(e => console.error("[Activity] JOIN_GAMING:", e.message));

  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/dismiss ────────────────────────────────
router.post("/sessions/:id/dismiss", async (req, res) => {
  try {
    await GamingSession.findByIdAndUpdate(req.params.id, { $addToSet: { dismissedBy: req.user._id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/not-interested ────────────────────────
router.post("/sessions/:id/not-interested", async (req, res) => {
  try {
    await GamingSession.findByIdAndUpdate(req.params.id, { $addToSet: { notInterestedUsers: req.user._id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/leave ──────────────────────────────────
router.post("/sessions/:id/leave", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const uid = req.user._id.toString();
    if (isHost(session, uid)) return res.status(400).json({ error: "Host cannot leave — use cancel" });
    if (!session.playersJoined.map(String).includes(uid))
      return res.status(400).json({ error: "You are not in this session" });

    session.playersJoined = session.playersJoined.filter(id => id.toString() !== uid);
    // ✅ Revert cardStatus if was full
    if (session.cardStatus === "full") {
      session.cardStatus = "waiting";
      session.status     = "waiting_for_players";
    }
    const name = displayName(req.user);
    session.messages.push({
      senderId: req.user._id, senderUsername: name,
      text: `${name} left the squad`, isSystemMsg: true,
    });
    await session.save();

    const io = req.app.get("io");
    if (io) emitPlayerLeft(io, session, uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  HOST POWERS
// ═══════════════════════════════════════════════════════════════

// ── POST /sessions/:id/start-early ───────────────────────────
router.post("/sessions/:id/start-early", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: "Only the host can start the session" });
    // ✅ Check cardStatus
    if (!isCardActive(session))
      return res.status(400).json({ error: "Session card is no longer active" });

    session.cardStatus = "started";
    session.status     = "started";
    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: "🚀 Host started the session early!", isSystemMsg: true,
    });
    await session.save();

    const io = req.app.get("io");
    if (io) emitSessionStarted(io, session._id.toString(), session.city);
    res.json(formatSession(session));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/cancel ─────────────────────────────────
router.post("/sessions/:id/cancel", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: "Only the host can cancel" });
    if (session.cardStatus === "cancelled")
      return res.status(400).json({ error: "Session already cancelled" });

    // ✅ Cancel is the ONLY action that sets BOTH statuses
    // Card gone AND chat closed immediately
    session.cardStatus = "cancelled";
    session.chatStatus = "closed";
    session.status     = "cancelled";
    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: "❌ Session cancelled by host.", isSystemMsg: true,
    });
    await session.save();

    const io = req.app.get("io");
    if (io) emitSessionCancelled(io, session._id.toString(), session.city);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/kick ───────────────────────────────────
router.post("/sessions/:id/kick", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: "Only the host can kick players" });

    const { targetUserId, targetUsername } = req.body;
    if (!targetUserId) return res.status(400).json({ error: "targetUserId required" });
    if (!session.playersJoined.map(String).includes(targetUserId))
      return res.status(400).json({ error: "User is not in this session" });

    session.playersJoined  = session.playersJoined.filter(id => id.toString() !== targetUserId);
    session.kickedPlayers.push(targetUserId);
    if (session.cardStatus === "full") {
      session.cardStatus = "waiting";
      session.status     = "waiting_for_players";
    }
    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: `🚫 ${targetUsername || "A player"} was removed by the host.`, isSystemMsg: true,
    });
    await session.save();

    const io = req.app.get("io");
    if (io) emitPlayerKicked(io, session._id.toString(), session.city, targetUserId);
    res.json(formatSession(session));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/mute ───────────────────────────────────
// durationMinutes: 5 | 10 | 0 (0 = rest of session)
router.post("/sessions/:id/mute", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: "Only the host can mute players" });

    const { targetUserId, targetUsername, durationMinutes } = req.body;
    if (!targetUserId) return res.status(400).json({ error: "targetUserId required" });

    const dur = Number(durationMinutes);
    if (![5, 10, 0].includes(dur))
      return res.status(400).json({ error: "durationMinutes must be 5, 10, or 0" });

    const mutedUntil = dur === 0
      ? new Date(session.chatExpiresAt)
      : new Date(Date.now() + dur * 60 * 1000);

    session.mutedPlayers = session.mutedPlayers.filter(m => m.userId.toString() !== targetUserId);
    session.mutedPlayers.push({ userId: targetUserId, mutedUntil });
    const durLabel = dur === 0 ? "for this session" : `for ${dur} minutes`;
    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: `🔇 ${targetUsername || "A player"} was muted ${durLabel}.`, isSystemMsg: true,
    });
    await session.save();

    const io = req.app.get("io");
    if (io) emitPlayerMuted(io, session._id.toString(), targetUserId, mutedUntil.toISOString());
    res.json({ ok: true, mutedUntil: mutedUntil.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/like ───────────────────────────────────
router.post("/sessions/:id/like", async (req, res) => {
  try {
    const uid    = req.user._id;
    const uidStr = uid.toString();
    const current = await GamingSession.findById(req.params.id).select("likedBy creatorId").lean();
    if (!current) return res.status(404).json({ error: "Session not found" });

    const alreadyLiked = (current.likedBy || []).map(String).includes(uidStr);
    const updated = await GamingSession.findByIdAndUpdate(
      req.params.id,
      alreadyLiked ? { $pull: { likedBy: uid } } : { $addToSet: { likedBy: uid } },
      { new: true, select: "likedBy" }
    );
    if (!updated) return res.status(404).json({ error: "Session not found" });

    res.json({
      liked:     !alreadyLiked,
      likeCount: (updated.likedBy || []).length,
      likedBy:   (updated.likedBy || []).map(String),
    });

    // ── Activity: LIKE_GAMING ─────────────────────────────────
    if (!alreadyLiked && current.creatorId.toString() !== uidStr) {
      const { createOrAggregateActivity } = require("../controllers/activityController");
      createOrAggregateActivity({
        userId:     current.creatorId.toString(),
        actorId:    uidStr,
        type:       "LIKE_GAMING",
        entityType: "gaming_session",
        entityId:   req.params.id,
      }).catch(e => console.error("[Activity] LIKE_GAMING:", e.message));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /sessions/:id ─────────────────────────────────────────
// Used by Android to re-open chat after Activity navigation
router.get("/sessions/:id", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const uid = req.user._id.toString();
    const isParticipant =
      session.creatorId.toString() === uid ||
      session.playersJoined.map(String).includes(uid);
    if (!isParticipant) return res.status(403).json({ error: "Not a participant" });
    res.json(formatSession(session));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  CHAT — all checks use chatStatus ONLY, never cardStatus
// ═══════════════════════════════════════════════════════════════

// ── GET /sessions/:id/chat ────────────────────────────────────
router.get("/sessions/:id/chat", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const uid = req.user._id.toString();
    if (!isMember(session, uid)) return res.status(403).json({ error: "Not a member" });
    // ✅ isChatOpen reads chatStatus ONLY — card expiry cannot block this
    if (!isChatOpen(session))    return res.status(410).json({ error: "Chat has closed" });

    let messages = session.messages || [];
    if (req.query.after) {
      const idx = messages.findIndex(m => m._id.toString() === req.query.after);
      if (idx !== -1) messages = messages.slice(idx + 1);
    }
    res.json({
      messages:        messages.map(m => formatMsg(m, session._id.toString())),
      pinnedMessageId: session.pinnedMessageId?.toString() || null,
      chatExpiresAt:   session.chatExpiresAt.toISOString(),
      chatStatus:      session.chatStatus || "open",
      mutedUntil:      session.mutedPlayers.find(m => m.userId.toString() === uid)?.mutedUntil?.toISOString() || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/chat ───────────────────────────────────
router.post("/sessions/:id/chat", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const uid = req.user._id.toString();
    if (!isMember(session, uid)) return res.status(403).json({ error: "Not a member" });
    // ✅ isChatOpen reads chatStatus ONLY
    if (!isChatOpen(session))    return res.status(410).json({ error: "Chat has closed" });
    if (isMuted(session, uid))   return res.status(403).json({ error: "You are muted" });

    // Rate limit
    const last = session.lastMessageAt?.get(uid);
    if (last && Date.now() - last.getTime() < MSG_RATE_LIMIT_MS)
      return res.status(429).json({ error: "Slow down — 1 message per second" });

    const text = (req.body.text || "").trim();
    if (!text || text.length > 500)
      return res.status(400).json({ error: "Message must be 1–500 characters" });

    session.messages.push({
      senderId:       req.user._id,
      senderUsername: displayName(req.user),
      senderAvatar:   req.user.profilePhoto || null,
      text,
    });
    session.lastMessageAt.set(uid, new Date());
    await session.save();

    const msg = session.messages[session.messages.length - 1];
    const formatted = formatMsg(msg, session._id.toString());

    const io = req.app.get("io");
    if (io) emitNewMessage(io, session._id.toString(), formatted);

    res.status(201).json(formatted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/pin-message ────────────────────────────
router.post("/sessions/:id/pin-message", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: "Only the host can pin messages" });

    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: "messageId required" });
    const msg = session.messages.id(messageId);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    session.messages.forEach(m => { m.isPinned = false; });
    msg.isPinned = true;
    session.pinnedMessageId = msg._id;
    await session.save();

    const formatted = formatMsg(msg, session._id.toString());
    const io = req.app.get("io");
    if (io) emitPinnedMessage(io, session._id.toString(), formatted);
    res.json({ ok: true, pinnedMessage: formatted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/react ──────────────────────────────────
router.post("/sessions/:id/react", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const uid = req.user._id.toString();
    if (!isMember(session, uid)) return res.status(403).json({ error: "Not a member" });

    const { messageId, emoji } = req.body;
    if (!messageId || !emoji) return res.status(400).json({ error: "messageId and emoji required" });
    const msg = session.messages.id(messageId);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const existIdx = msg.reactions.findIndex(r => r.userId.toString() === uid && r.emoji === emoji);
    if (existIdx !== -1) {
      msg.reactions.splice(existIdx, 1);
    } else {
      msg.reactions = msg.reactions.filter(r => r.userId.toString() !== uid);
      msg.reactions.push({ userId: req.user._id, emoji });
    }
    await session.save();

    const reactions = msg.reactions.map(r => ({ userId: r.userId.toString(), emoji: r.emoji }));
    const io = req.app.get("io");
    if (io) emitNewReaction(io, session._id.toString(), { messageId, reactions });
    res.json({ ok: true, reactions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/report ─────────────────────────────────
router.post("/sessions/:id/report", async (req, res) => {
  try {
    const { targetUserId, reason } = req.body;
    console.warn(`[gaming] REPORT session=${req.params.id} target=${targetUserId} by=${req.user._id} reason="${reason}"`);
    res.json({ ok: true, message: "Report received. Thank you." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  §10, §11: NOTIFICATION HELPER
// ═══════════════════════════════════════════════════════════════

async function sendNewSessionNotifications(session, hostUserId) {
  try {
    const limit     = BOOST_LIMITS[session.boostLevel] || 50;
    const gameLabel = session.customGameName || session.gameType;

    const candidates = await User.find({
      _id: { $ne: hostUserId },
      "questionnaire.city": {
        $regex: new RegExp(`^${session.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      },
      "questionnaire.hangoutPreferences": {
        $in: ["Play games", "🎮 Play games", "🎮  Play games"],
      },
      fcmTokens: { $exists: true, $not: { $size: 0 } }
    }).select("_id").limit(limit).lean();

    if (!candidates.length) {
      console.log(`[gamingNotif] 0 eligible users in "${session.city}"`);
      return;
    }

    const excluded = (session.notInterestedUsers || []).map(String);

    for (const user of candidates) {
      const uid = String(user._id);
      if (excluded.includes(uid)) continue;
      if (!canNotifyToday(uid)) {
        console.log(`[gamingNotif] Skipping ${uid} — daily limit reached`);
        continue;
      }
      sendGamingPush({
        recipientId: uid,
        title:       "🎮 Gaming session looking for players",
        body:        `Someone is starting a ${gameLabel} session. Join before it fills up.`,
        data:        { sessionId: String(session._id), type: "new_session" }
      })
      .then(() => { markNotified(uid); console.log(`[gamingNotif] ✅ Sent to ${uid}`); })
      .catch(err => console.error(`[gamingNotif] ❌ Push failed for ${uid}:`, err.message));
    }
  } catch (err) {
    console.error("[sendNewSessionNotifications]", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  EXPIRY JOB — two independent steps, no cross-contamination
// ═══════════════════════════════════════════════════════════════

function startExpiryJob(io) {
  setInterval(async () => {
    try {
      const now = new Date();

      // ── Step 1: Expire the CARD ──────────────────────────────
      // cardExpiresAt (= createdAt + 10min) passed AND card still active.
      // chatStatus is NOT touched — chat keeps running for 3h independently.
      const cardResult = await GamingSession.updateMany(
        {
          cardStatus:    { $in: ["waiting", "full"] },
          cardExpiresAt: { $lte: now },
        },
        { $set: { cardStatus: "expired", status: "expired" } }
      );
      if (cardResult.modifiedCount > 0) {
        console.log(`[gaming] Step 1: ${cardResult.modifiedCount} card(s) expired → chatStatus untouched`);
        if (io) {
          const justExpired = await GamingSession.find({
            cardStatus: "expired",
            updatedAt:  { $gte: new Date(now - 70_000) }
          }).select("_id city");
          for (const s of justExpired) emitSessionExpired(io, s._id.toString(), s.city);
        }
      }

      // ── Step 2: Close the CHAT ───────────────────────────────
      // chatExpiresAt (= startTime + 3h) passed AND chat still open.
      // cardStatus is NOT touched — already 'expired' or 'cancelled'.
      const chatResult = await GamingSession.updateMany(
        {
          chatStatus:    "open",
          chatExpiresAt: { $lte: now },
        },
        { $set: { chatStatus: "closed" } }
      );
      if (chatResult.modifiedCount > 0)
        console.log(`[gaming] Step 2: ${chatResult.modifiedCount} chat(s) closed`);

    } catch (e) { console.error("[gaming] Expiry job error:", e.message); }
  }, 60_000);
  console.log("[gaming] Dual-status expiry job started (60s interval)");
}

module.exports = router;
module.exports.startExpiryJob = startExpiryJob;
