/**
 * routes/gamingRoutes.js
 * Mounted at /api/session in server.js
 * Auth handled by middleware — req.user._id available on all routes.
 */

const express       = require('express');
const router        = express.Router();
const GamingSession = require('../models/GamingSession');
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
} = require('../sockets/sessionSocket');
const { sendGamingPush } = require('../utils/gamingPush');

// ── Constants ─────────────────────────────────────────────────
const THREE_HOURS_MS    = 3 * 60 * 60 * 1000;
const TEN_MIN_MS        = 10 * 60 * 1000;   // §4: session expires after 10min if not filled
const TWO_HOURS_MS      = 2 * 60 * 60 * 1000;
const FIVE_MIN_MS       = 5 * 60 * 1000;    // §3: existing session check window
const MSG_RATE_LIMIT_MS = 1000;

// Boost notification limits (§11)
const BOOST_LIMITS = { normal: 50, boost20: 200, boost50: 1000 };

// ── §10: Daily notification rate-limiter (max 2 per user per day) ─────────
// Key = "userId:YYYY-M-D"  →  count sent today (auto-resets with date key).
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
function isChatOpen(session) {
  return Date.now() < new Date(session.chatExpiresAt).getTime() &&
         !['cancelled', 'expired'].includes(session.status);
}
function isActive(session) {
  return ['waiting_for_players', 'full', 'starting'].includes(session.status);
}
function displayName(user) {
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User';
}
function resolveCity(req, bodyCity) {
  return (
    bodyCity ||
    req.user?.questionnaire?.city ||
    req.user?.city ||
    'Unknown'
  ).trim();
}

/** Serialise session → client JSON with all §5 fields */
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
    notInterestedUsers: (s.notInterestedUsers || []).map(String),  // §5, §12
    boostLevel:         s.boostLevel || 'normal',                  // §5, §11
    likedBy:            (s.likedBy || []).map(String),             // like system
    status:             s.status,                                  // §4 values
    startTime:          s.startTime.toISOString(),
    chatExpiresAt:      s.chatExpiresAt.toISOString(),
    expiresAt:          s.expiresAt?.toISOString() || null,        // §5
    createdAt:          s.createdAt.toISOString(),
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

// ── Check + expire sessions past expiresAt ────────────────────
async function checkAndExpire(session, io) {
  if (
    !['expired', 'cancelled', 'completed', 'in_progress'].includes(session.status) &&
    session.expiresAt &&
    new Date() > session.expiresAt
  ) {
    session.status = 'expired';
    session.messages.push({
      senderId:       session.creatorId,
      senderUsername: session.creatorUsername,
      text:           'This session has expired.',
      isSystemMsg:    true
    });
    await session.save();
    if (io) emitSessionExpired(io, session._id.toString(), session.city);
  }
  return session;
}

// ═══════════════════════════════════════════════════════════════
//  SESSION ROUTES  (§14)
// ═══════════════════════════════════════════════════════════════

// ── GET /sessions/can-create  — anti-spam §17 ─────────────────
// Must be declared BEFORE /:id routes
router.get('/sessions/can-create', async (req, res) => {
  try {
    const recent = await GamingSession.findOne({
      creatorId: req.user._id,
      status:    { $nin: ['expired', 'cancelled', 'completed'] },
      createdAt: { $gte: new Date(Date.now() - TWO_HOURS_MS) },
    }).sort({ createdAt: -1 });

    if (!recent) return res.json({ canCreate: true, nextAllowedAt: null });

    const next = new Date(recent.createdAt.getTime() + TWO_HOURS_MS);
    if (Date.now() >= next.getTime()) return res.json({ canCreate: true, nextAllowedAt: null });

    res.json({ canCreate: false, nextAllowedAt: next.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/check-existing  — §3 ──────────────────────
// Must be declared BEFORE /:id routes
router.post('/sessions/check-existing', async (req, res) => {
  try {
    const { gameType } = req.body;
    if (!gameType) return res.status(400).json({ error: 'gameType required' });

    const fiveMinutesAgo = new Date(Date.now() - FIVE_MIN_MS);

    // §3: findOne({ game, status: "waiting_for_players", createdAt within last 5min })
    const existing = await GamingSession.findOne({
      gameType,
      status:             'waiting_for_players',       // §3 exact requirement
      createdAt:          { $gte: fiveMinutesAgo },
      creatorId:          { $ne: req.user._id },
      playersJoined:      { $nin: [req.user._id] },
      notInterestedUsers: { $nin: [req.user._id] }     // §12
    });

    if (existing) {
      return res.json({
        sessionExists:  true,
        sessionId:      existing._id.toString(),
        playersWaiting: existing.playersJoined.length + 1   // +1 for creator
      });
    }
    res.json({ sessionExists: false, sessionId: null, playersWaiting: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /sessions  — §14 GET /gaming/active-sessions ─────────
router.get('/sessions', async (req, res) => {
  try {
    const io   = req.app.get('io');
    const city = resolveCity(req, req.query.city);

    const sessions = await GamingSession.find({
      city,
      status:             { $in: ['waiting_for_players', 'full', 'starting'] },
      notInterestedUsers: { $nin: [req.user._id] },    // §12
      kickedPlayers:      { $nin: [req.user._id] },
    }).sort({ startTime: 1 }).limit(20);

    const live = [];
    for (const s of sessions) {
      await checkAndExpire(s, io);
      if (!['expired', 'cancelled'].includes(s.status)) live.push(formatSession(s));
    }
    res.json(live);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions  — §14 POST /gaming/create ────────────────
router.post('/sessions', async (req, res) => {
  try {
    const {
      gameType, customGameName, playersNeeded,
      startTime, optionalMessage, city,
      boostLevel = 'normal'
    } = req.body;

    if (!gameType)      return res.status(400).json({ error: 'gameType is required' });
    if (!startTime)     return res.status(400).json({ error: 'startTime is required' });
    if (!playersNeeded) return res.status(400).json({ error: 'playersNeeded is required' });

    const start = new Date(startTime);
    if (isNaN(start.getTime()))
      return res.status(400).json({ error: 'startTime is not a valid date' });

    const bufferMs = 60 * 1000;
    if (start < new Date(Date.now() - bufferMs))
      return res.status(400).json({ error: 'Start time must be in the future' });
    if (start - Date.now() > THREE_HOURS_MS + bufferMs)
      return res.status(400).json({ error: 'Session must start within 3 hours' });

    if (gameType === 'OTHER') {
      const name = (customGameName || '').trim();
      if (name.length < 2 || name.length > 30)
        return res.status(400).json({ error: 'Custom game name must be 2–30 characters' });
    }

    // §17: anti-spam — no new session if user has active session
    const existing = await GamingSession.findOne({
      creatorId: req.user._id,
      status:    { $in: ['waiting_for_players', 'full', 'starting', 'in_progress'] },
    });
    if (existing) return res.status(409).json({
      error:         'You already have an active session',
      nextAllowedAt: new Date(existing.createdAt.getTime() + TWO_HOURS_MS).toISOString(),
    });

    const sessionCity   = resolveCity(req, city);
    const chatExpiresAt = new Date(start.getTime() + THREE_HOURS_MS);
    // §4, §5: expiresAt = createdAt + 10min (set by pre-save hook)

    const session = await GamingSession.create({
      creatorId:       req.user._id,
      creatorUsername: displayName(req.user),
      city:            sessionCity,
      gameType:        gameType.trim(),
      customGameName:  gameType === 'OTHER' ? (customGameName || '').trim() : null,
      playersNeeded:   Number(playersNeeded),
      startTime:       start,
      chatExpiresAt,
      optionalMessage: optionalMessage?.trim() || null,
      status:          'waiting_for_players',   // §4
      boostLevel:      (boostLevel || 'normal').toLowerCase(),
    });

    console.log(`[gaming] Created ${session._id} by ${req.user._id} in ${sessionCity}`);

    const io = req.app.get('io');
    if (io) emitSessionCreated(io, session.city, formatSession(session));

    // §10, §11: notify eligible players (async, fire-and-forget)
    sendNewSessionNotifications(session, req.user._id).catch(console.error);

    res.status(201).json(formatSession(session));
  } catch (e) {
    console.error('[gaming POST /sessions]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sessions/:id/join  — §6, §14 POST /gaming/join ─────
router.post('/sessions/:id/join', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await checkAndExpire(session, io);
    if (['expired', 'cancelled', 'completed'].includes(session.status))
      return res.status(410).json({ error: 'Session is no longer available' });
    if (session.status === 'in_progress')
      return res.status(403).json({ error: 'Session already started' });

    const uid = req.user._id.toString();
    if (isHost(session, uid))
      return res.status(400).json({ error: 'You created this session' });
    if (session.kickedPlayers.map(String).includes(uid))
      return res.status(403).json({ error: 'You were removed from this session' });
    if (session.playersJoined.map(String).includes(uid))
      return res.status(400).json({ error: 'Already joined' });

    // +1 accounts for creator who is not in playersJoined
    if (session.playersJoined.length + 1 >= session.playersNeeded)
      return res.status(409).json({ error: 'Session is full' });

    session.playersJoined.push(req.user._id);

    // §6: if session becomes full → status: full
    const totalPlayers = session.playersJoined.length + 1;  // +1 for creator
    if (totalPlayers >= session.playersNeeded) {
      session.status = 'full';
    }

    const name = displayName(req.user);
    // §7: system message
    session.messages.push({
      senderId: req.user._id, senderUsername: name,
      text: `${name} joined the session`, isSystemMsg: true,   // §7
    });
    await session.save();

    // §7: emit socket event to session chat
    if (io) emitPlayerJoined(io, session);

    // §6: notify host
    sendGamingPush({
      recipientId:  session.creatorId.toString(),
      title:        `${session.gameType} Session`,
      body:         `${name} joined your ${session.gameType} session! 🎮`,
      data:         { type: 'PLAYER_JOINED', sessionId: session._id.toString() },
    }).catch(err => console.error('[gamingPush] join notification failed:', err));

    res.json(formatSession(session));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/not-interested  — §12, §14 ────────────
// Alias: /dismiss maps here too for backwards compat
router.post('/sessions/:id/not-interested', async (req, res) => {
  try {
    // §12: store userId in session.notInterestedUsers
    await GamingSession.findByIdAndUpdate(req.params.id, {
      $addToSet: { notInterestedUsers: req.user._id }
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kept for Android client backward compat
router.post('/sessions/:id/dismiss', async (req, res) => {
  try {
    await GamingSession.findByIdAndUpdate(req.params.id, {
      $addToSet: { notInterestedUsers: req.user._id }
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/leave  — §8, §14 POST /gaming/leave ───
router.post('/sessions/:id/leave', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const uid = req.user._id.toString();
    if (isHost(session, uid))
      return res.status(400).json({ error: 'Host cannot leave — use cancel' });
    if (!session.playersJoined.map(String).includes(uid))
      return res.status(400).json({ error: 'You are not in this session' });

    session.playersJoined = session.playersJoined.filter(id => id.toString() !== uid);

    // Revert from full if a player leaves
    if (session.status === 'full') session.status = 'waiting_for_players';

    const name = displayName(req.user);
    // §8: emit system message
    session.messages.push({
      senderId: req.user._id, senderUsername: name,
      text: `${name} left the session`, isSystemMsg: true,   // §8
    });
    await session.save();

    if (io) emitPlayerLeft(io, session, uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  HOST CONTROLS  (§9)
// ═══════════════════════════════════════════════════════════════

// ── POST /sessions/:id/start-early  — §9, §14 POST /gaming/start-session
router.post('/sessions/:id/start-early', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: 'Only the host can start the session' });
    if (!['waiting_for_players', 'full', 'starting'].includes(session.status))
      return res.status(400).json({ error: 'Session cannot be started in its current state' });

    session.status = 'in_progress';   // §4
    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: '🚀 Host started the session!', isSystemMsg: true,
    });
    await session.save();

    if (io) emitSessionStarted(io, session._id.toString(), session.city);
    res.json(formatSession(session));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/cancel  — §13 ─────────────────────────
router.post('/sessions/:id/cancel', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: 'Only the host can cancel' });
    if (['expired', 'cancelled', 'completed'].includes(session.status))
      return res.status(400).json({ error: 'Session already ended' });

    session.status = 'cancelled';   // §13
    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: '❌ Session cancelled by host.', isSystemMsg: true,   // §13
    });
    await session.save();

    if (io) emitSessionCancelled(io, session._id.toString(), session.city);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/kick  — §9, §14 POST /gaming/kick-player
router.post('/sessions/:id/kick', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: 'Only the host can kick players' });
    // §9: kick allowed only before session starts
    if (session.status === 'in_progress')
      return res.status(400).json({ error: 'Cannot kick after session has started' });

    const { targetUserId, targetUsername } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
    if (!session.playersJoined.map(String).includes(targetUserId))
      return res.status(400).json({ error: 'User is not in this session' });

    session.playersJoined  = session.playersJoined.filter(id => id.toString() !== targetUserId);
    session.kickedPlayers.push(targetUserId);
    if (session.status === 'full') session.status = 'waiting_for_players';

    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: `🚫 ${targetUsername || 'A player'} was removed by the host.`, isSystemMsg: true,
    });
    await session.save();

    if (io) emitPlayerKicked(io, session._id.toString(), session.city, targetUserId);
    res.json(formatSession(session));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/mute ───────────────────────────────────
router.post('/sessions/:id/mute', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: 'Only the host can mute players' });

    const { targetUserId, targetUsername, durationMinutes } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });

    const dur = Number(durationMinutes);
    if (![5, 10, 0].includes(dur))
      return res.status(400).json({ error: 'durationMinutes must be 5, 10, or 0' });

    const mutedUntil = dur === 0
      ? new Date(session.chatExpiresAt)
      : new Date(Date.now() + dur * 60 * 1000);

    session.mutedPlayers = session.mutedPlayers.filter(m => m.userId.toString() !== targetUserId);
    session.mutedPlayers.push({ userId: targetUserId, mutedUntil });
    const durLabel = dur === 0 ? 'for this session' : `for ${dur} minutes`;
    session.messages.push({
      senderId: req.user._id, senderUsername: session.creatorUsername,
      text: `🔇 ${targetUsername || 'A player'} was muted ${durLabel}.`, isSystemMsg: true,
    });
    await session.save();

    if (io) emitPlayerMuted(io, session._id.toString(), targetUserId, mutedUntil.toISOString());
    res.json({ ok: true, mutedUntil: mutedUntil.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sessions/:id/like  — toggle like ───────────────────
router.post('/sessions/:id/like', async (req, res) => {
  try {
    const uid     = req.user._id;
    const uidStr  = uid.toString();

    // Check current like state without loading full session
    const current = await GamingSession.findById(req.params.id).select('likedBy').lean();
    if (!current) return res.status(404).json({ error: 'Session not found' });

    const alreadyLiked = (current.likedBy || []).map(String).includes(uidStr);

    // ✅ Use atomic operators — works correctly even if likedBy wasn't in schema before
    const updated = await GamingSession.findByIdAndUpdate(
      req.params.id,
      alreadyLiked
        ? { $pull:     { likedBy: uid } }
        : { $addToSet: { likedBy: uid } },
      { new: true, select: 'likedBy' }
    );

    if (!updated) return res.status(404).json({ error: 'Session not found' });

    res.json({
      liked:     !alreadyLiked,
      likeCount: (updated.likedBy || []).length,
      likedBy:   (updated.likedBy || []).map(String),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  CHAT  (§7)
// ═══════════════════════════════════════════════════════════════

router.get('/sessions/:id/chat', async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const uid = req.user._id.toString();
    if (!isMember(session, uid)) return res.status(403).json({ error: 'Not a member' });
    if (!isChatOpen(session))    return res.status(410).json({ error: 'Chat has closed' });

    let messages = session.messages || [];
    if (req.query.after) {
      const idx = messages.findIndex(m => m._id.toString() === req.query.after);
      if (idx !== -1) messages = messages.slice(idx + 1);
    }
    res.json({
      messages:        messages.map(m => formatMsg(m, session._id.toString())),
      pinnedMessageId: session.pinnedMessageId?.toString() || null,
      chatExpiresAt:   session.chatExpiresAt.toISOString(),
      mutedUntil:      session.mutedPlayers.find(m => m.userId.toString() === uid)
                         ?.mutedUntil?.toISOString() || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sessions/:id/chat', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const uid = req.user._id.toString();
    if (!isMember(session, uid)) return res.status(403).json({ error: 'Not a member' });
    if (!isChatOpen(session))    return res.status(410).json({ error: 'Chat has closed' });
    if (isMuted(session, uid))   return res.status(403).json({ error: 'You are muted' });

    const last = session.lastMessageAt?.get(uid);
    if (last && Date.now() - last.getTime() < MSG_RATE_LIMIT_MS)
      return res.status(429).json({ error: 'Slow down — 1 message per second' });

    const text = (req.body.text || '').trim();
    if (!text || text.length > 500)
      return res.status(400).json({ error: 'Message must be 1–500 characters' });

    session.messages.push({
      senderId:       req.user._id,
      senderUsername: displayName(req.user),
      senderAvatar:   req.user.profilePhoto || null,
      text,
    });
    session.lastMessageAt.set(uid, new Date());
    await session.save();

    const msg       = session.messages[session.messages.length - 1];
    const formatted = formatMsg(msg, session._id.toString());

    if (io) emitNewMessage(io, session._id.toString(), formatted);
    res.status(201).json(formatted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sessions/:id/pin-message', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isHost(session, req.user._id.toString()))
      return res.status(403).json({ error: 'Only the host can pin messages' });

    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    const msg = session.messages.id(messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    session.messages.forEach(m => { m.isPinned = false; });
    msg.isPinned = true;
    session.pinnedMessageId = msg._id;
    await session.save();

    const formatted = formatMsg(msg, session._id.toString());
    if (io) emitPinnedMessage(io, session._id.toString(), formatted);
    res.json({ ok: true, pinnedMessage: formatted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sessions/:id/react', async (req, res) => {
  try {
    const io      = req.app.get('io');
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const uid = req.user._id.toString();
    if (!isMember(session, uid)) return res.status(403).json({ error: 'Not a member' });

    const { messageId, emoji } = req.body;
    if (!messageId || !emoji) return res.status(400).json({ error: 'messageId and emoji required' });
    const msg = session.messages.id(messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const existIdx = msg.reactions.findIndex(r => r.userId.toString() === uid && r.emoji === emoji);
    if (existIdx !== -1) {
      msg.reactions.splice(existIdx, 1);
    } else {
      msg.reactions = msg.reactions.filter(r => r.userId.toString() !== uid);
      msg.reactions.push({ userId: req.user._id, emoji });
    }
    await session.save();

    const reactions = msg.reactions.map(r => ({ userId: r.userId.toString(), emoji: r.emoji }));
    if (io) emitNewReaction(io, session._id.toString(), { messageId, reactions });
    res.json({ ok: true, reactions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sessions/:id/report', async (req, res) => {
  try {
    const { targetUserId, reason } = req.body;
    console.warn(`[gaming] REPORT session=${req.params.id} target=${targetUserId} by=${req.user._id} reason="${reason}"`);
    res.json({ ok: true, message: 'Report received. Thank you.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  §10, §11: NOTIFICATION HELPER
//
//  Fixed vs original:
//    1. city filter uses questionnaire.city  (not top-level city)
//    2. hangout filter uses questionnaire.hangoutPreferences  (not top-level)
//    3. enforces 2-per-user-per-day cap via _dailyNotifCount
// ═══════════════════════════════════════════════════════════════

async function sendNewSessionNotifications(session, hostUserId) {
  try {
    const mongoose  = require('mongoose');
    const User      = mongoose.model('User');
    const limit     = BOOST_LIMITS[session.boostLevel] || 50;
    const gameLabel = session.customGameName || session.gameType;

    // §10: eligible = hangoutPreferences includes "Play games", same city, not host
    // FIX: city and hangoutPreferences live inside questionnaire, not at top level
    const candidates = await User.find({
      _id:  { $ne: hostUserId },
      'questionnaire.city': {
        $regex: new RegExp(`^${session.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      },
      'questionnaire.hangoutPreferences': {
        $in: ['Play games', '🎮 Play games', '🎮  Play games'],
      },
      fcmTokens: { $exists: true, $not: { $size: 0 } }
    }).select('_id').limit(limit).lean();

    if (!candidates.length) {
      console.log(`[gamingNotif] 0 eligible users in "${session.city}"`);
      return;
    }

    console.log(`[gamingNotif] ${candidates.length} candidate(s) — enforcing 2/day cap`);

    // §12: skip users in notInterestedUsers
    const excluded = (session.notInterestedUsers || []).map(String);

    for (const user of candidates) {
      const uid = String(user._id);

      if (excluded.includes(uid)) continue;

      // FIX: enforce 2-per-user-per-day cap
      if (!canNotifyToday(uid)) {
        console.log(`[gamingNotif] Skipping ${uid} — daily limit reached`);
        continue;
      }

      sendGamingPush({
        recipientId: uid,
        title:       '🎮 Gaming session looking for players',
        body:        `Someone is starting a ${gameLabel} session. Join before it fills up.`,
        data:        { sessionId: String(session._id), type: 'new_session' }
      })
      .then(() => {
        markNotified(uid);
        console.log(`[gamingNotif] ✅ Sent to ${uid}`);
      })
      .catch(err => console.error(`[gamingNotif] ❌ Push failed for ${uid}:`, err.message));
    }
  } catch (err) {
    console.error('[sendNewSessionNotifications]', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  §4, §13: EXPIRY JOB  (createdAt + 10min)
// ═══════════════════════════════════════════════════════════════

function startExpiryJob(io) {
  setInterval(async () => {
    try {
      // §4: expire sessions where expiresAt passed AND status is still active
      const expired = await GamingSession.find({
        status:    { $in: ['waiting_for_players', 'full', 'starting'] },
        expiresAt: { $lte: new Date() }
      });

      for (const s of expired) {
        s.status = 'expired';   // §4, §13
        s.messages.push({
          senderId:       s.creatorId,
          senderUsername: s.creatorUsername,
          text:           'This gaming session has expired.',   // §13
          isSystemMsg:    true
        });
        await s.save();
        if (io) emitSessionExpired(io, s._id.toString(), s.city);
        console.log(`[gaming] Session ${s._id} expired`);
      }
    } catch (e) { console.error('[gaming] Expiry job error:', e.message); }
  }, 60_000);
  console.log('[gaming] Expiry job started (60s interval)');
}

module.exports = router;
module.exports.startExpiryJob = startExpiryJob;
