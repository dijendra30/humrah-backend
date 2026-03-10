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
 */

const express       = require("express");
const router        = express.Router();
const GamingSession = require("../models/GamingSession");
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

// ── Constants ─────────────────────────────────────────────────
const THREE_HOURS_MS    = 3 * 60 * 60 * 1000;
const FIVE_MIN_MS       = 5 * 60 * 1000;
const TWO_HOURS_MS      = 2 * 60 * 60 * 1000;
const MSG_RATE_LIMIT_MS = 1000;   // 1 msg/sec per user

// ── Helpers ───────────────────────────────────────────────────
function isCardExpired(session) {
  return Date.now() > new Date(session.startTime).getTime() + FIVE_MIN_MS;
}
async function checkAndExpire(session) {
  if (!["EXPIRED","CANCELLED"].includes(session.status) && isCardExpired(session)) {
    session.status = "EXPIRED";
    await session.save();
  }
  return session;
}
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
function isChatOpen(session) {
  return Date.now() < new Date(session.chatExpiresAt).getTime() &&
         !["CANCELLED","EXPIRED"].includes(session.status);
}
function formatSession(s) {
  const pinned = s.pinnedMessageId
    ? s.messages.find(m => m._id.toString() === s.pinnedMessageId?.toString())
    : null;
  return {
    sessionId:       s._id.toString(),
    creatorId:       s.creatorId.toString(),
    creatorUsername: s.creatorUsername,
    creatorCity:     s.city,
    gameType:        s.gameType,
    customGameName:  s.customGameName || null,
    playersNeeded:   s.playersNeeded,
    playersJoined:   (s.playersJoined || []).map(String),
    kickedPlayers:   (s.kickedPlayers || []).map(String),
    mutedPlayers:    (s.mutedPlayers || []).map(m => ({
      userId: m.userId.toString(), mutedUntil: m.mutedUntil.toISOString(),
    })),
    startTime:       s.startTime.toISOString(),
    chatExpiresAt:   s.chatExpiresAt.toISOString(),
    createdAt:       s.createdAt.toISOString(),
    status:          s.status,
    optionalMessage: s.optionalMessage || null,
    pinnedMessage:   pinned ? formatMsg(pinned, s._id.toString()) : null,
  };
}
function formatMsg(m, sessionId) {
  return {
    messageId:      m._id.toString(),
    sessionId,
    senderId:       m.senderId.toString(),
    senderUsername: m.senderUsername,
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

// ═══════════════════════════════════════════════════════════════
//  SESSION ROUTES
// ═══════════════════════════════════════════════════════════════

// ── GET /sessions/can-create  (MUST be before /:id routes) ────
router.get("/sessions/can-create", async (req, res) => {
  try {
    const recent = await GamingSession.findOne({
      creatorId: req.user._id,
      status:    { $nin: ["EXPIRED","CANCELLED"] },
      createdAt: { $gte: new Date(Date.now() - TWO_HOURS_MS) },
    }).sort({ createdAt: -1 });
    if (!recent) return res.json({ canCreate: true, nextAllowedAt: null });
    const next = new Date(recent.createdAt.getTime() + TWO_HOURS_MS);
    if (Date.now() >= next.getTime()) return res.json({ canCreate: true, nextAllowedAt: null });
    res.json({ canCreate: false, nextAllowedAt: next.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /sessions ─────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  try {
    const city = (req.query.city || req.user?.questionnaire?.city || "Unknown").trim();
    const sessions = await GamingSession.find({
      city,
      status:        { $nin: ["EXPIRED","CANCELLED"] },
      createdAt:     { $gte: new Date(Date.now() - THREE_HOURS_MS) },
      dismissedBy:   { $ne: req.user._id },
      kickedPlayers: { $ne: req.user._id },
    }).sort({ startTime: 1 }).limit(20);
    const live = [];
    for (const s of sessions) {
      await checkAndExpire(s);
      if (!["EXPIRED","CANCELLED"].includes(s.status)) live.push(formatSession(s));
    }
    res.json(live);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions ────────────────────────────────────────────
router.post("/sessions", async (req, res) => {
  try {
    const { gameType, customGameName, playersNeeded, startTime, optionalMessage, city } = req.body;
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

    const existing = await GamingSession.findOne({
      creatorId: req.user._id,
      status:    { $in: ["ACTIVE","STARTED"] },
    });
    if (existing) return res.status(409).json({
      error: "You already have an active session",
      nextAllowedAt: new Date(existing.createdAt.getTime() + TWO_HOURS_MS).toISOString(),
    });

    const sessionCity  = (city || req.user?.questionnaire?.city || "Unknown").trim();
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
      status:          "ACTIVE",
    });

    console.log(`[gaming] Created ${session._id} by ${req.user._id} in ${sessionCity}`);
    const io = req.app.get("io");
    if (io) emitSessionCreated(io, session.city, formatSession(session));

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
    await checkAndExpire(session);
    if (["EXPIRED","CANCELLED"].includes(session.status))
      return res.status(410).json({ error: "Session is no longer available" });
    if (session.status === "STARTED")
      return res.status(403).json({ error: "Session already started" });

    const uid = req.user._id.toString();
    if (isHost(session, uid))    return res.status(400).json({ error: "You created this session" });
    if (session.kickedPlayers.map(String).includes(uid))
      return res.status(403).json({ error: "You were removed from this session" });
    if (session.playersJoined.map(String).includes(uid))
      return res.status(400).json({ error: "Already joined" });
    if (session.playersJoined.length + 1 >= session.playersNeeded)
      return res.status(409).json({ error: "Session is full" });

    session.playersJoined.push(req.user._id);
    const name = displayName(req.user);
    session.messages.push({
      senderId: req.user._id, senderUsername: name,
      text: `${name} joined the squad 🎮`, isSystemMsg: true,
    });
    await session.save();

    const io = req.app.get("io");
    if (io) emitPlayerJoined(io, session);
    res.json(formatSession(session));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/dismiss ────────────────────────────────
router.post("/sessions/:id/dismiss", async (req, res) => {
  try {
    await GamingSession.findByIdAndUpdate(req.params.id, { $addToSet: { dismissedBy: req.user._id } });
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
    if (session.status !== "ACTIVE") return res.status(400).json({ error: "Session is not active" });

    session.status = "STARTED";
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
    if (["EXPIRED","CANCELLED"].includes(session.status))
      return res.status(400).json({ error: "Session already ended" });

    session.status = "CANCELLED";
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

// ═══════════════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════════════

// ── GET /sessions/:id/chat ────────────────────────────────────
router.get("/sessions/:id/chat", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const uid = req.user._id.toString();
    if (!isMember(session, uid)) return res.status(403).json({ error: "Not a member" });
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
      msg.reactions.splice(existIdx, 1);  // toggle off
    } else {
      msg.reactions = msg.reactions.filter(r => r.userId.toString() !== uid); // remove old
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

// ── Cron job ──────────────────────────────────────────────────
function startExpiryJob() {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - FIVE_MIN_MS);
      const r = await GamingSession.updateMany(
        { status: { $nin: ["EXPIRED","CANCELLED"] }, startTime: { $lte: cutoff } },
        { $set: { status: "EXPIRED" } }
      );
      if (r.modifiedCount > 0)
        console.log(`[gaming] Expired ${r.modifiedCount} session(s)`);
    } catch (e) { console.error("[gaming] Expiry job error:", e.message); }
  }, 60_000);
}

module.exports = router;
module.exports.startExpiryJob = startExpiryJob;
