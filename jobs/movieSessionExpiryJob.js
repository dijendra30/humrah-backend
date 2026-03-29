// jobs/movieSessionExpiryJob.js
// Runs every 60 s — marks expired sessions & chats.
// Called from connectDB() in server.js, same pattern as sessionExpiryJob.

const MovieSession = require('../models/MovieSession');
const MovieChat    = require('../models/MovieChat');

function startMovieSessionExpiryJob() {
  setInterval(async () => {
    try {
      const now = new Date();

      // 1. Expire sessions whose showDateTime + 5 min has passed
      const sessResult = await MovieSession.updateMany(
        { status: 'active', expiresAt: { $lte: now } },
        { $set: { status: 'expired' } }
      );
      if (sessResult.modifiedCount > 0) {
        console.log(`🎬 Movie sessions expired: ${sessResult.modifiedCount}`);
      }

      // 2. Expire chats whose showDateTime + 3 hrs has passed
      const chatResult = await MovieChat.updateMany(
        { status: 'active', expiresAt: { $lte: now } },
        { $set: { status: 'expired' } }
      );
      if (chatResult.modifiedCount > 0) {
        console.log(`💬 Movie chats expired: ${chatResult.modifiedCount}`);
      }

    } catch (err) {
      console.error('movieSessionExpiryJob error:', err.message);
    }
  }, 60_000); // every 60 seconds

  console.log('✅ Movie session expiry job started (60s interval)');
}

module.exports = { startMovieSessionExpiryJob };
