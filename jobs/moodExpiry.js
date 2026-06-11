// jobs/moodExpiry.js
// Cron: every 30 minutes — auto-expire stale mood sessions.
// Any MatchingTodayMood doc where expiresAt has passed but visible=true
// gets set to visible=false so it drops out of mood-matches queries instantly.
// This is a safety net; the queries themselves check expiresAt > now anyway.
'use strict';

const cron            = require('node-cron');
const MatchingTodayMood = require('../models/MatchingTodayMood');

// Every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    const result = await MatchingTodayMood.updateMany(
      { visible: true, expiresAt: { $lte: new Date() } },
      { $set: { visible: false } }
    );
    if (result.modifiedCount > 0) {
      console.log(`🧹 [MoodExpiry] Auto-expired ${result.modifiedCount} stale mood session(s)`);
    }
  } catch (err) {
    console.error('❌ [MoodExpiry] Cron error:', err.message);
  }
});

console.log('⏰ [MoodExpiry] Cron registered — runs every 30 min');
