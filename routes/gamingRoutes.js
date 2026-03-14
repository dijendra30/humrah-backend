const express        = require('express');
const router         = express.Router();
const GamingSession  = require('../models/GamingSession');
const { authenticate } = require('../middleware/auth');
const gamingPush     = require('../utils/gamingPush');
const { startExpiryJob } = require('../jobs/sessionExpiryJob');

// All routes require auth (§14)
router.use(authenticate);

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/** How many users to notify per boost level (§11) */
const BOOST_NOTIFY_LIMITS = {
  NORMAL:  50,
  BOOST20: 200,
  BOOST50: 1000
};

/** Anti-spam window: 30 minutes (§17) */
const ANTI_SPAM_MS = 30 * 60 * 1000;

/** Session auto-expire: 10 minutes after creation if not filled (§4, §13) */
const SESSION_EXPIRE_MS = 10 * 60 * 1000;

/** Chat stays open 3h after startTime */
const CHAT_EXPIRE_MS = 3 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
//  GET /sessions/can-create  — anti-spam check (§17)
// ─────────────────────────────────────────────────────────────

router.get('/sessions/can-create', async (req, res) => {
  try {
    const since = new Date(Date.now() - ANTI_SPAM_MS);
    const existing = await GamingSession.findOne({
      hostId:    req.user.userId,
      status:    { $in: ['waiting_for_players', 'full', 'starting', 'in_progress'] },
      createdAt: { $gte: since }
    });

    if (existing) {
      const nextAllowedAt = new Date(existing.createdAt.getTime() + ANTI_SPAM_MS);
      return res.json({ canCreate: false, nextAllowedAt });
    }
    res.json({ canCreate: true, nextAllowedAt: null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/check-existing  — §3 existing session check
// ─────────────────────────────────────────────────────────────

router.post('/sessions/check-existing', async (req, res) => {
  try {
    const { gameType } = req.body;
    if (!gameType) return res.status(400).json({ error: 'gameType required' });

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const existing = await GamingSession.findOne({
      game:      gameType,
      status:    'waiting_for_players',
      createdAt: { $gte: fiveMinutesAgo },
      // Don't return sessions where this user is host or already joined
      hostId:         { $ne: req.user.userId },
      playersJoined:  { $nin: [req.user.userId] },
      notInterestedUsers: { $nin: [req.user.userId] }
    });

    if (existing) {
      return res.json({
        sessionExists:  true,
        sessionId:      existing._id,
        // playersWaiting = total players in session (host counts as 1)
        playersWaiting: existing.playersJoined.length + 1
      });
    }
    res.json({ sessionExists: false, sessionId: null, playersWaiting: null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /sessions  — active sessions for this city (§14)
// ─────────────────────────────────────────────────────────────

router.get('/sessions', async (req, res) => {
  try {
    const { city, limit = 20 } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });

    const sessions = await GamingSession.find({
      city,
      status:             { $in: ['waiting_for_players', 'full', 'starting', 'in_progress'] },
      expiresAt:          { $gt: new Date() },
      notInterestedUsers: { $nin: [req.user.userId] },  // §12
      kickedPlayers:      { $nin: [req.user.userId] }
    })
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    res.json(sessions.map(s => s.toClientJSON()));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions  — create session (§14 POST /gaming/create)
// ─────────────────────────────────────────────────────────────

router.post('/sessions', async (req, res) => {
  try {
    const {
      gameType, customGameName, playersNeeded,
      startTime, optionalMessage, city,
      boostLevel = 'NORMAL'
    } = req.body;

    // ── Anti-spam (§17) ───────────────────────────────────────
    const since = new Date(Date.now() - ANTI_SPAM_MS);
    const spamCheck = await GamingSession.findOne({
      hostId:    req.user.userId,
      status:    { $in: ['waiting_for_players', 'full', 'starting', 'in_progress'] },
      createdAt: { $gte: since }
    });
    if (spamCheck) {
      return res.status(429).json({ error: 'You already have an active session. Please wait before creating a new one.' });
    }

    // ── Validation ────────────────────────────────────────────
    if (!gameType || !playersNeeded || !startTime || !city) {
      return res.status(400).json({ error: 'gameType, playersNeeded, startTime, city are required' });
    }
    const start = new Date(startTime);
    const now   = new Date();
    if (start < new Date(now - 60_000)) {
      return res.status(400).json({ error: 'startTime must be in the future' });
    }
    if (start > new Date(now.getTime() + 3 * 60 * 60 * 1000 + 60_000)) {
      return res.status(400).json({ error: 'Session must start within 3 hours' });
    }

    const expiresAt    = new Date(now.getTime() + SESSION_EXPIRE_MS);   // §4: +10min
    const chatExpiresAt = new Date(start.getTime() + CHAT_EXPIRE_MS);   // start + 3h

    const session = await GamingSession.create({
      hostId:         req.user.userId,
      hostUsername:   req.user.username,
      city,
      game:           gameType,
      customGameName: customGameName || null,
      playersNeeded:  Number(playersNeeded),
      playersJoined:  [],
      status:         'waiting_for_players',
      boostLevel:     boostLevel.toUpperCase(),
      startTime:      start,
      chatExpiresAt,
      expiresAt,
      optionalMessage: optionalMessage || null
    });

    // ── Push to eligible users (§10, §11) ─────────────────────
    // Fire-and-forget — don't block the response
    sendSessionNotifications(session, req.user.userId).catch(console.error);

    // ── Emit socket event to city room ────────────────────────
    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`city:${city}`).emit('session_created', session.toClientJSON());
    }

    res.status(201).json(session.toClientJSON());
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/join  (§6, §14 POST /gaming/join)
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/join', async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.status === 'expired' || session.status === 'cancelled') {
      return res.status(410).json({ error: 'Session is no longer active' });
    }
    if (session.kickedPlayers.map(String).includes(String(req.user.userId))) {
      return res.status(403).json({ error: 'You have been removed from this session' });
    }
    if (String(session.hostId) === String(req.user.userId)) {
      return res.status(400).json({ error: 'You are the host of this session' });
    }
    if (session.playersJoined.map(String).includes(String(req.user.userId))) {
      return res.status(200).json(session.toClientJSON()); // already joined
    }
    if (session.isFull()) {
      return res.status(409).json({ error: 'Session is full' });
    }

    // Atomic add player
    const updated = await GamingSession.findOneAndUpdate(
      {
        _id:          session._id,
        status:       { $in: ['waiting_for_players', 'full'] },
        $expr:        { $lt: [{ $add: [{ $size: '$playersJoined' }, 1] }, '$playersNeeded'] }
      },
      {
        $addToSet: { playersJoined: req.user.userId },
        $set:      { status: 'waiting_for_players' }   // recalculated below
      },
      { new: true }
    );

    if (!updated) return res.status(409).json({ error: 'Session is full' });

    // Recalculate status
    const newCount = updated.playersJoined.length + 1; // +1 for host
    if (newCount >= updated.playersNeeded) {
      updated.status = 'full';
      await updated.save();
    }

    // System message in chat
    const sysMsg = {
      senderId:       req.user.userId,
      senderUsername: req.user.username,
      text:           `${req.user.username} joined the session`,
      isSystemMsg:    true
    };
    updated.messages.push(sysMsg);
    await updated.save();

    // Notify host (§6)
    gamingPush.sendGamingPush({
      recipientId: updated.hostId,
      title:       '🎮 Player joined!',
      body:        `${req.user.username} joined your gaming session.`,
      data:        { sessionId: String(updated._id), type: 'player_joined' }
    }).catch(console.error);

    // Socket emit
    const io = req.app.get('io');
    if (io) {
      const payload = {
        session_id:    String(updated._id),
        userId:        String(req.user.userId),
        username:      req.user.username,
        playersJoined: updated.playersJoined.map(String)
      };
      io.of('/gaming').to(`city:${updated.city}`).emit('session_updated', payload);
      io.of('/gaming').to(`session:${updated._id}`).emit('player_joined', payload);
      io.of('/gaming').to(`session:${updated._id}`).emit('new_message', {
        session_id: String(updated._id),
        message:    sysMsg
      });
    }

    res.json(updated.toClientJSON());
  } catch (err) {
    console.error('Join session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/dismiss  — Not Interested (§12)
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/dismiss', async (req, res) => {
  try {
    await GamingSession.findByIdAndUpdate(req.params.id, {
      $addToSet: { notInterestedUsers: req.user.userId }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/leave  (§8, §14 POST /gaming/leave)
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/leave', async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (String(session.hostId) === String(req.user.userId)) {
      return res.status(400).json({ error: 'Host must cancel, not leave' });
    }

    session.playersJoined = session.playersJoined.filter(
      id => String(id) !== String(req.user.userId)
    );
    // Recalculate status
    if (session.status === 'full') session.status = 'waiting_for_players';

    const sysMsg = {
      senderId:       req.user.userId,
      senderUsername: req.user.username,
      text:           `${req.user.username} left the session`,
      isSystemMsg:    true
    };
    session.messages.push(sysMsg);
    await session.save();

    const io = req.app.get('io');
    if (io) {
      const payload = {
        session_id:    String(session._id),
        userId:        String(req.user.userId),
        playersJoined: session.playersJoined.map(String)
      };
      io.of('/gaming').to(`city:${session.city}`).emit('session_updated', payload);
      io.of('/gaming').to(`session:${session._id}`).emit('player_left', payload);
      io.of('/gaming').to(`session:${session._id}`).emit('new_message', {
        session_id: String(session._id),
        message:    sysMsg
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/start-early  (§9, §14 POST /gaming/start-session)
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/start-early', async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (String(session.hostId) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Only host can start the session' });
    }

    session.status = 'in_progress';
    await session.save();

    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`city:${session.city}`).emit('session_started', { session_id: String(session._id) });
      io.of('/gaming').to(`session:${session._id}`).emit('session_started', { session_id: String(session._id) });
    }

    res.json(session.toClientJSON());
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/cancel  — host cancels (§13)
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/cancel', async (req, res) => {
  try {
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (String(session.hostId) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Only host can cancel' });
    }

    session.status = 'cancelled';

    const sysMsg = {
      senderId:       req.user.userId,
      senderUsername: req.user.username,
      text:           'Session was cancelled by the host.',
      isSystemMsg:    true
    };
    session.messages.push(sysMsg);
    await session.save();

    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`city:${session.city}`).emit('session_cancelled', { session_id: String(session._id) });
      io.of('/gaming').to(`session:${session._id}`).emit('session_cancelled', { session_id: String(session._id) });
      io.of('/gaming').to(`session:${session._id}`).emit('new_message', {
        session_id: String(session._id),
        message:    sysMsg
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/kick  (§9, §14 POST /gaming/kick-player)
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/kick', async (req, res) => {
  try {
    const { targetUserId, targetUsername } = req.body;
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (String(session.hostId) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Only host can kick players' });
    }
    if (session.hasStarted()) {
      return res.status(400).json({ error: 'Cannot kick after session has started' });
    }

    session.playersJoined = session.playersJoined.filter(
      id => String(id) !== String(targetUserId)
    );
    session.kickedPlayers.push(targetUserId);
    if (session.status === 'full') session.status = 'waiting_for_players';

    const sysMsg = {
      senderId:       req.user.userId,
      senderUsername: req.user.username,
      text:           `${targetUsername} was removed from the session.`,
      isSystemMsg:    true
    };
    session.messages.push(sysMsg);
    await session.save();

    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`session:${session._id}`).emit('player_removed', {
        session_id: String(session._id),
        userId:     String(targetUserId)
      });
      io.of('/gaming').to(`session:${session._id}`).emit('new_message', {
        session_id: String(session._id),
        message:    sysMsg
      });
    }

    res.json(session.toClientJSON());
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/mute
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/mute', async (req, res) => {
  try {
    const { targetUserId, targetUsername, durationMinutes } = req.body;
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (String(session.hostId) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Only host can mute players' });
    }

    const mutedUntil = durationMinutes === 0
      ? session.chatExpiresAt           // rest of session
      : new Date(Date.now() + durationMinutes * 60 * 1000);

    // Remove existing mute entry for this user, then add new one
    session.mutedPlayers = session.mutedPlayers.filter(
      m => String(m.userId) !== String(targetUserId)
    );
    session.mutedPlayers.push({ userId: targetUserId, mutedUntil });
    await session.save();

    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`session:${session._id}`).emit('player_muted', {
        session_id: String(session._id),
        userId:     String(targetUserId),
        mutedUntil: mutedUntil.toISOString()
      });
    }

    res.json({ ok: true, mutedUntil });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /sessions/:id/chat
// ─────────────────────────────────────────────────────────────

router.get('/sessions/:id/chat', async (req, res) => {
  try {
    const { after } = req.query;
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let messages = session.messages;
    if (after) {
      const afterIdx = messages.findIndex(m => String(m._id) === after);
      if (afterIdx !== -1) messages = messages.slice(afterIdx + 1);
    }

    // Check mute status for requesting user
    const muteEntry = session.mutedPlayers.find(
      m => String(m.userId) === String(req.user.userId) && m.mutedUntil > new Date()
    );

    res.json({
      messages:       messages.map(m => ({
        messageId:      m._id,
        sessionId:      session._id,
        senderId:       m.senderId,
        senderUsername: m.senderUsername,
        text:           m.text,
        sentAt:         m.sentAt,
        isPinned:       String(m._id) === String(session.pinnedMessageId),
        isSystemMsg:    m.isSystemMsg,
        reactions:      m.reactions
      })),
      pinnedMessageId: session.pinnedMessageId,
      chatExpiresAt:   session.chatExpiresAt,
      mutedUntil:      muteEntry ? muteEntry.mutedUntil : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/chat
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/chat', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (new Date() > session.chatExpiresAt) {
      return res.status(410).json({ error: 'Chat has expired' });
    }

    // Mute check
    const muteEntry = session.mutedPlayers.find(
      m => String(m.userId) === String(req.user.userId) && m.mutedUntil > new Date()
    );
    if (muteEntry) return res.status(403).json({ error: 'You are muted', mutedUntil: muteEntry.mutedUntil });

    const msg = {
      senderId:       req.user.userId,
      senderUsername: req.user.username,
      text:           text.trim(),
      isSystemMsg:    false
    };
    session.messages.push(msg);
    await session.save();

    const saved = session.messages[session.messages.length - 1];
    const response = {
      messageId:      saved._id,
      sessionId:      session._id,
      senderId:       saved.senderId,
      senderUsername: saved.senderUsername,
      text:           saved.text,
      sentAt:         saved.sentAt,
      isPinned:       false,
      isSystemMsg:    false,
      reactions:      []
    };

    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`session:${session._id}`).emit('new_message', {
        session_id: String(session._id),
        message:    response
      });
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/pin-message
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/pin-message', async (req, res) => {
  try {
    const { messageId } = req.body;
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (String(session.hostId) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Only host can pin messages' });
    }

    const msg = session.messages.id(messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    // Unpin previous
    session.messages.forEach(m => { m.isPinned = false; });
    msg.isPinned = true;
    session.pinnedMessageId = msg._id;
    await session.save();

    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`session:${session._id}`).emit('message_pinned', {
        session_id: String(session._id),
        message:    msg
      });
    }

    res.json({ ok: true, pinnedMessage: msg });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/react
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/react', async (req, res) => {
  try {
    const { messageId, emoji } = req.body;
    const session = await GamingSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const msg = session.messages.id(messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const existingIdx = msg.reactions.findIndex(
      r => String(r.userId) === String(req.user.userId) && r.emoji === emoji
    );
    if (existingIdx !== -1) {
      msg.reactions.splice(existingIdx, 1); // toggle off
    } else {
      // Remove any other reaction by this user first (one reaction per user per message)
      msg.reactions = msg.reactions.filter(r => String(r.userId) !== String(req.user.userId));
      msg.reactions.push({ userId: req.user.userId, emoji });
    }

    await session.save();

    const io = req.app.get('io');
    if (io) {
      io.of('/gaming').to(`session:${session._id}`).emit('reaction_updated', {
        session_id: String(session._id),
        messageId,
        reactions:  msg.reactions
      });
    }

    res.json({ ok: true, reactions: msg.reactions });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /sessions/:id/report
// ─────────────────────────────────────────────────────────────

router.post('/sessions/:id/report', async (req, res) => {
  try {
    const { targetUserId, reason } = req.body;
    // Log report — extend with Report model if needed
    console.log(`[REPORT] session=${req.params.id} reporter=${req.user.userId} target=${targetUserId} reason=${reason}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  PRIVATE: send push notifications on session create (§10, §11)
// ─────────────────────────────────────────────────────────────

async function sendSessionNotifications(session, hostUserId) {
  try {
    const mongoose = require('mongoose');
    const User     = mongoose.model('User');
    const limit    = BOOST_NOTIFY_LIMITS[session.boostLevel] || 50;

    // §10: eligible = hangoutPreferences includes "Play games", same city, not host
    const candidates = await User.find({
      _id:                { $ne: hostUserId },
      city:               session.city,
      hangoutPreferences: 'Play games',   // adjust to your actual User field name
      fcmTokens:          { $exists: true, $not: { $size: 0 } }
    })
      .select('_id')
      .limit(limit)
      .lean();

    const gameLabel     = session.customGameName || session.game;
    const notInterested = session.notInterestedUsers.map(String);

    for (const user of candidates) {
      // §12: never notify users who dismissed this session
      if (notInterested.includes(String(user._id))) continue;

      // gamingPush handles FCM token lookup + stale token cleanup internally
      await gamingPush.sendGamingPush({
        recipientId: String(user._id),
        title:       '🎮 Gaming session looking for players',
        body:        `Someone is starting a ${gameLabel} session. Join before it fills up.`,
        data:        { sessionId: String(session._id), type: 'new_session' }
      });
    }
  } catch (err) {
    console.error('[sendSessionNotifications] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  EXPORT + EXPIRY JOB
// ─────────────────────────────────────────────────────────────

module.exports = router;
module.exports.startExpiryJob = startExpiryJob;
