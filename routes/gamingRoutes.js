// ─────────────────────────────────────────────────────────────
//  routes/gamingSession.routes.js   (Express)
//
//  Mount in app.js:
//    const gamingRoutes = require("./routes/gamingSession.routes");
//    app.use("/gaming", gamingRoutes);
//
//  Assumes:  authMiddleware attaches req.user = { _id, username, city }
// ─────────────────────────────────────────────────────────────

const express       = require("express");
const router        = express.Router();
const GamingSession = require("../models/GamingSession");                      // ✅ correct model path
const { authenticate: authMiddleware } = require("../middleware/auth");         // ✅ destructure from Humrah auth.js
const {
  emitSessionCreated,
  emitPlayerJoined,
  emitSessionExpired,
} = require("../sockets/sessionSocket");                                        // ✅ real-time socket helpers

// ─── helpers ─────────────────────────────────────────────────

const THREE_HOURS_MS  = 3 * 60 * 60 * 1000;
const FIVE_MIN_MS     = 5 * 60 * 1000;
const ONE_HOUR_MS     = 60 * 60 * 1000;
const TWO_HOURS_MS    = 2 * 60 * 60 * 1000;

function isSessionExpired(session) {
  return Date.now() > new Date(session.startTime).getTime() + FIVE_MIN_MS;
}

// Mark a session expired if needed and save
async function checkAndExpire(session) {
  if (session.status !== "EXPIRED" && isSessionExpired(session)) {
    session.status = "EXPIRED";
    await session.save();
  }
  return session;
}

// ─────────────────────────────────────────────────────────────
//  GET /gaming/sessions
//  Fetch nearby active sessions (same city, created < 3h ago)
// ─────────────────────────────────────────────────────────────
router.get("/sessions", authMiddleware, async (req, res) => {
  try {
    const city     = req.query.city || req.user.city;
    const threeHAgo = new Date(Date.now() - THREE_HOURS_MS);

    const sessions = await GamingSession.find({
      city,
      status:    { $ne: "EXPIRED" },
      createdAt: { $gte: threeHAgo },
      dismissedBy: { $ne: req.user._id },
    }).sort({ startTime: 1 }).limit(20);

    // Lazily expire stale sessions
    const live = [];
    for (const s of sessions) {
      await checkAndExpire(s);
      if (s.status !== "EXPIRED") live.push(formatSession(s));
    }

    res.json(live);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /gaming/sessions
//  Create a new session (anti-spam: 1 per 2h)
// ─────────────────────────────────────────────────────────────
router.post("/sessions", authMiddleware, async (req, res) => {
  try {
    const { gameType, customGameName, playersNeeded, startTime, optionalMessage, city } = req.body;

    // ── Validate startTime ────────────────────────────────────
    const start = new Date(startTime);
    const now   = new Date();
    // ✅ 30-second buffer to absorb network latency & timezone edge cases
    const bufferMs = 30 * 1000;
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
    const existing = await GamingSession.findOne({
      creatorId: req.user._id,
      status:    { $ne: "EXPIRED" },
      createdAt: { $gte: new Date(Date.now() - TWO_HOURS_MS) },
    });
    if (existing)
      return res.status(409).json({
        error: "You already have an active session",
        nextAllowedAt: new Date(existing.createdAt.getTime() + TWO_HOURS_MS).toISOString(),
      });

    const session = await GamingSession.create({
      creatorId:      req.user._id,
      creatorUsername: req.user.username,
      city:           city || req.user.city,
      gameType,
      customGameName: gameType === "OTHER" ? (customGameName || "").trim() : null,
      playersNeeded:  Number(playersNeeded),
      startTime:      start,
      optionalMessage: optionalMessage?.trim() || null,
    });

    // ✅ Real-time: broadcast new session to everyone in this city
    const io = req.app.get("io");
    if (io) emitSessionCreated(io, session.city, formatSession(session));

    res.status(201).json(formatSession(session));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /gaming/sessions/can-create
//  ⚠️  MUST be registered before any /:id route or Express will
//      match the literal string "can-create" as the :id param.
// ─────────────────────────────────────────────────────────────
router.get("/sessions/can-create", authMiddleware, async (req, res) => {
  try {
    const recent = await GamingSession.findOne({
      creatorId: req.user._id,
      createdAt: { $gte: new Date(Date.now() - TWO_HOURS_MS) },
    }).sort({ createdAt: -1 });

    if (!recent) return res.json({ canCreate: true, nextAllowedAt: null });

    const nextAllowedAt = new Date(recent.createdAt.getTime() + TWO_HOURS_MS);
    if (Date.now() >= nextAllowedAt.getTime())
      return res.json({ canCreate: true, nextAllowedAt: null });

    res.json({ canCreate: false, nextAllowedAt: nextAllowedAt.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /gaming/sessions/:id/join
// ─────────────────────────────────────────────────────────────
router.post("/sessions/:id/join", authMiddleware, async (req, res) => {
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

    const totalPlayers = session.playersJoined.length + 1; // +1 creator
    if (totalPlayers >= session.playersNeeded)
      return res.status(409).json({ error: "Session is full" });

    session.playersJoined.push(req.user._id);
    await session.save();

    // ✅ Real-time: update player count for city feed + session room
    const io = req.app.get("io");
    if (io) emitPlayerJoined(io, session);

    res.json(formatSession(session));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /gaming/sessions/:id/dismiss
// ─────────────────────────────────────────────────────────────
router.post("/sessions/:id/dismiss", authMiddleware, async (req, res) => {
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
//  GET /gaming/sessions/:id/chat
//  Only session members (creator + joined) can fetch
// ─────────────────────────────────────────────────────────────
router.get("/sessions/:id/chat", authMiddleware, async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const userId    = req.user._id.toString();
    const isMember  = session.creatorId.toString() === userId ||
                      session.playersJoined.map(String).includes(userId);
    if (!isMember)
      return res.status(403).json({ error: "Not a member of this session" });

    // Chat closes 1h after start time
    const chatClosesAt = new Date(session.startTime.getTime() + ONE_HOUR_MS);
    if (Date.now() > chatClosesAt.getTime())
      return res.status(410).json({ error: "Chat has closed" });

    // Filter after a given messageId if provided
    let messages = session.messages;
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
//  POST /gaming/sessions/:id/chat
// ─────────────────────────────────────────────────────────────
router.post("/sessions/:id/chat", authMiddleware, async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const userId   = req.user._id.toString();
    const isMember = session.creatorId.toString() === userId ||
                     session.playersJoined.map(String).includes(userId);
    if (!isMember)
      return res.status(403).json({ error: "Not a member of this session" });

    const chatClosesAt = new Date(session.startTime.getTime() + ONE_HOUR_MS);
    if (Date.now() > chatClosesAt.getTime())
      return res.status(410).json({ error: "Chat has closed" });

    const text = (req.body.text || "").trim();
    if (!text || text.length > 500)
      return res.status(400).json({ error: "Message must be 1–500 characters" });

    session.messages.push({
      senderId:       req.user._id,
      senderUsername: req.user.username,
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

// ─────────────────────────────────────────────────────────────
//  CRON JOB — run every minute to mark expired sessions
//  Call this from your app.js:
//    require("./routes/gamingSession.routes").startExpiryJob();
// ─────────────────────────────────────────────────────────────
function startExpiryJob() {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - FIVE_MIN_MS);
      const result = await GamingSession.updateMany(
        { status: { $ne: "EXPIRED" }, startTime: { $lte: cutoff } },
        { $set: { status: "EXPIRED" } }
      );
      if (result.modifiedCount > 0)
        console.log(`[GamingSession] Expired ${result.modifiedCount} session(s)`);
    } catch (err) {
      console.error("[GamingSession] Expiry job error:", err.message);
    }
  }, 60_000); // every 60 seconds
}

// ─── format helper ────────────────────────────────────────────
function formatSession(s) {
  return {
    sessionId:      s._id.toString(),
    creatorId:      s.creatorId.toString(),
    creatorUsername: s.creatorUsername,
    creatorCity:    s.city,
    gameType:       s.gameType,
    customGameName: s.customGameName,
    playersNeeded:  s.playersNeeded,
    playersJoined:  s.playersJoined.map(String),
    startTime:      s.startTime.toISOString(),
    createdAt:      s.createdAt.toISOString(),
    status:         s.status,
    optionalMessage: s.optionalMessage,
  };
}

module.exports = router;
module.exports.startExpiryJob = startExpiryJob;
