const GamingSession = require('../models/GamingSession');

/**
 * sessionExpiryJob.js
 *
 * Runs every 60 seconds.
 * Expires sessions where:
 *   - expiresAt has passed  (§4: createdAt + 10min if not filled)
 *   - OR startTime + 5min grace has passed
 *
 * When expired:
 *   - Sets status → 'expired'
 *   - Adds system message to chat
 *   - Emits socket event to city + session rooms (§13)
 */

function startExpiryJob(io) {
  setInterval(async () => {
    try {
      const now = new Date();

      // Find sessions that should be expired
      const expiredSessions = await GamingSession.find({
        status:    { $in: ['waiting_for_players', 'full', 'starting'] },
        expiresAt: { $lte: now }
      });

      for (const session of expiredSessions) {
        session.status = 'expired';

        const sysMsg = {
          senderId:       session.hostId,
          senderUsername: session.hostUsername,
          text:           'This gaming session has expired.',
          isSystemMsg:    true
        };
        session.messages.push(sysMsg);
        await session.save();

        // Emit to city room + session room
        if (io) {
          const payload = { session_id: String(session._id) };
          io.of('/gaming').to(`city:${session.city}`).emit('session_expired', payload);
          io.of('/gaming').to(`session:${session._id}`).emit('session_expired', payload);
          io.of('/gaming').to(`session:${session._id}`).emit('new_message', {
            session_id: String(session._id),
            message:    sysMsg
          });
        }

        console.log(`[ExpiryJob] Session ${session._id} expired`);
      }
    } catch (err) {
      console.error('[ExpiryJob] Error:', err.message);
    }
  }, 60_000); // every 60 seconds

  console.log('[ExpiryJob] Session expiry job started');
}

module.exports = { startExpiryJob };
