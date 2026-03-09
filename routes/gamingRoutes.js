const express       = require("express");
const router        = express.Router();
const GamingSession = require("../models/GamingSession");
const {
  emitSessionCreated,
  emitPlayerJoined,
} = require("../sockets/sessionSocket");

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const FIVE_MIN_MS    = 5 * 60 * 1000;
const ONE_HOUR_MS    = 60 * 60 * 1000;
const TWO_HOURS_MS   = 2 * 60 * 60 * 1000;

function isSessionExpired(session) {
  return Date.now() > new Date(session.startTime).getTime() + FIVE_MIN_MS;
}

async function checkAndExpire(session) {
  if (session.status !== "EXPIRED" && isSessionExpired(session)) {
    session.status = "EXPIRED";
    await session.save();
  }
  return session;
}

// ─────────────────────────────────────────────────────────────
//  GET /api/session/sessions
// ─────────────────────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  try {
    const city     = req.query.city || req.user?.questionnaire?.city || 'Unknown';
    const threeHAgo = new Date(Date.now() - THREE_HOURS_MS);

    const sessions = await GamingSession.find({
      city,
      status:    { $nin: ["EXPIRED", "CANCELLED"] },
      createdAt: { $gte: threeHAgo },
      dismissedBy: { $ne: req.user._id },
    }).sort({ startTime: 1 }).limit(20);

    const live = [];
    for (const s of sessions) {
      await checkAndExpire(s);
      if (s.status !== "EXPIRED") live.push(formatSession(s));
    }

    res.json(live);
  } catch (err) {
    console.error("[gamingRoutes GET /sessions]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/session/sessions/can-create   ← MUST be before /:id
// ─────────────────────────────────────────────────────────────
router.get("/sessions/can-create", async (req, res) => {
  try {
    const recent = await GamingSession.findOne({
      creatorId: req.user._id,
      status:    { $nin: ["EXPIRED", "CANCELLED"] },
      createdAt: { $gte: new Date(Date.now() - TWO_HOURS_MS) },
    }).sort({ createdAt: -1 });

    if (!recent) return res.json({ canCreate: true, nextAllowedAt: null });

    const nextAllowedAt = new Date(recent.createdAt.getTime() + TWO_HOURS_MS);
    if (Date.now() >= nextAllowedAt.getTime())
      return res.json({ canCreate: true, nextAllowedAt: null });

    res.json({ canCreate: false, nextAllowedAt: nextAllowedAt.toISOString() });
  } catch (err) {
    console.error("[gamingRoutes GET /sessions/can-create]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/session/sessions
// ─────────────────────────────────────────────────────────────
router.post("/sessions", async (req, res) => {
  try {
    const { gameType, customGameName, playersNeeded, startTime, optionalMessage, city } = req.body;

    // ── Validate required fields ──────────────────────────────
    if (!gameType)    return res.status(400).json({ error: "gameType is required" });
    if (!startTime)   return res.status(400).json({ error: "startTime is required" });
    if (!playersNeeded) return res.status(400).json({ error: "playersNeeded is required" });

    // ── Validate startTime ────────────────────────────────────
    const start = new Date(startTime);
    if (isNaN(start.getTime()))
      return res.status(400).json({ error: "startTime is not a valid date" });

    const now      = new Date();
    const bufferMs = 60 * 1000; // 60s buffer
    if (start < new Date(now.getTime() - bufferMs))
      return res.status(400).json({ error: "Start time must be in the future" });
    if (start - now > THREE_HOURS_MS + bufferMs)
      return res.status(400).json({ error: "Session must start within 3 hours" });

    // ── Validate OTHER custom name ────────────────────────────
    if (gameType === "OTHER") {
      const name = (customGameName || "").trim();
      if (name.length < 2 || name.length > 30)
        return res.status(400).json({ error: "Custom game name must be 2–30 characters" });
    }

    // ── Anti-spam: 1 active session per user per 2h ───────────
    // Only count sessions with a valid ACTIVE/STARTED status
    const existing = await GamingSession.findOne({
      creatorId: req.user._id,
      status:    { $in: ["ACTIVE", "STARTED"] },  // ✅ only real active sessions
    });
    if (existing) {
      return res.status(409).json({
        error: "You already have an active session",
        nextAllowedAt: new Date(existing.createdAt.getTime() + TWO_HOURS_MS).toISOString(),
      });
    }

    // ── Resolve city ──────────────────────────────────────────
    // Priority: request body → questionnaire city → fallback
    const sessionCity = (city || req.user?.questionnaire?.city || 'Unknown').trim();

    const session = await GamingSession.create({
      creatorId:       req.user._id,
      creatorUsername: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'User',
      city:            sessionCity,
      gameType:        gameType.trim(),
      customGameName:  gameType === "OTHER" ? (customGameName || "").trim() : null,
      playersNeeded:   Number(playersNeeded),
      startTime:       start,
      optionalMessage: optionalMessage?.trim() || null,
      status:          "ACTIVE",
    });

    console.log(`[gamingRoutes] Session created: ${session._id} by ${req.user._id} in ${sessionCity}`);

    const io = req.app.get("io");
    if (io) emitSessionCreated(io, session.city, formatSession(session));

    res.status(201).json(formatSession(session));
  } catch (err) {
    console.error("[gamingRoutes POST /sessions]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/session/sessions/:id/join
// ─────────────────────────────────────────────────────────────
router.post("/sessions/:id/join", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    await checkAndExpire(session);
    if (session.status === "EXPIRED")
      return res.status(410).json({ error: "Session has expired" });

    const userId = req.user._id.toString();
    if (session.creatorId.toString() === userId)
      return res.status(400).json({ error: "You created this session" });
    if (session.playersJoined.map(String).includes(userId))
      return res.status(400).json({ error: "Already joined" });

    const totalPlayers = session.playersJoined.length + 1;
    if (totalPlayers >= session.playersNeeded)
      return res.status(409).json({ error: "Session is full" });

    session.playersJoined.push(req.user._id);
    await session.save();

    const io = req.app.get("io");
    if (io) emitPlayerJoined(io, session);

    res.json(formatSession(session));
  } catch (err) {
    console.error("[gamingRoutes POST /sessions/:id/join]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/session/sessions/:id/dismiss
// ─────────────────────────────────────────────────────────────
router.post("/sessions/:id/dismiss", async (req, res) => {
  try {
    await GamingSession.findByIdAndUpdate(req.params.id, {
      $addToSet: { dismissedBy: req.user._id }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/session/sessions/:id/chat
// ─────────────────────────────────────────────────────────────
router.get("/sessions/:id/chat", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const userId   = req.user._id.toString();
    const isMember = session.creatorId.toString() === userId ||
                     session.playersJoined.map(String).includes(userId);
    if (!isMember) return res.status(403).json({ error: "Not a member of this session" });

    const chatClosesAt = new Date(session.startTime.getTime() + ONE_HOUR_MS);
    if (Date.now() > chatClosesAt.getTime())
      return res.status(410).json({ error: "Chat has closed" });

    let messages = session.messages || [];
    if (req.query.after) {
      const idx = messages.findIndex(m => m._id.toString() === req.query.after);
      if (idx !== -1) messages = messages.slice(idx + 1);
    }

    res.json(messages.map(m => ({
      messageId:      m._id.toString(),
      sessionId:      session._id.toString(),
      senderId:       m.senderId.toString(),
      senderUsername: m.senderUsername,
      text:           m.text,
      sentAt:         m.sentAt.toISOString(),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/session/sessions/:id/chat
// ─────────────────────────────────────────────────────────────
router.post("/sessions/:id/chat", async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const userId   = req.user._id.toString();
    const isMember = session.creatorId.toString() === userId ||
                     session.playersJoined.map(String).includes(userId);
    if (!isMember) return res.status(403).json({ error: "Not a member of this session" });

    const chatClosesAt = new Date(session.startTime.getTime() + ONE_HOUR_MS);
    if (Date.now() > chatClosesAt.getTime())
      return res.status(410).json({ error: "Chat has closed" });

    const text = (req.body.text || "").trim();
    if (!text || text.length > 500)
      return res.status(400).json({ error: "Message must be 1–500 characters" });

    session.messages.push({
      senderId:       req.user._id,
      senderUsername: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'User',
      text,
    });
    await session.save();

    const msg = session.messages[session.messages.length - 1];
    res.status(201).json({
      messageId:      msg._id.toString(),
      sessionId:      session._id.toString(),
      senderId:       msg.senderId.toString(),
      senderUsername: msg.senderUsername,
      text:           msg.text,
      sentAt:         msg.sentAt.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── format helper ────────────────────────────────────────────
function formatSession(s) {
  return {
    sessionId:       s._id.toString(),
    creatorId:       s.creatorId.toString(),
    creatorUsername: s.creatorUsername,
    creatorCity:     s.city,
    gameType:        s.gameType,
    customGameName:  s.customGameName || null,
    playersNeeded:   s.playersNeeded,
    playersJoined:   (s.playersJoined || []).map(String),
    startTime:       s.startTime.toISOString(),
    createdAt:       s.createdAt.toISOString(),
    status:          s.status,
    optionalMessage: s.optionalMessage || null,
  };
}

module.exports = router;
