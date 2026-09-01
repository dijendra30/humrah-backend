const HumrahRoom = require('../models/HumrahRoom');

exports.runHumrahRoomExpiry = async () => {
  try {
    const now = new Date();

    // SUGGESTED -> CLOSED (expired after 2 hours)
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await HumrahRoom.updateMany(
      { status: 'SUGGESTED', createdAt: { $lt: twoHoursAgo } },
      { $set: { status: 'CLOSED' } }
    );

    // ACTIVE/FULL -> INACTIVE (no messages for 24 hours)
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await HumrahRoom.updateMany(
      { 
        status: { $in: ['ACTIVE', 'FULL'] }, 
        lastMessageAt: { $lt: twentyFourHoursAgo }
      },
      { $set: { status: 'INACTIVE' } }
    );
    // Also inactive if no lastMessageAt and created 24h ago
    await HumrahRoom.updateMany(
      { 
        status: { $in: ['ACTIVE', 'FULL'] }, 
        lastMessageAt: null,
        createdAt: { $lt: twentyFourHoursAgo }
      },
      { $set: { status: 'INACTIVE' } }
    );

    // INACTIVE -> CLOSED (inactive for 48 hours)
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    await HumrahRoom.updateMany(
      { 
        status: 'INACTIVE', 
        $or: [
          { lastMessageAt: { $lt: fortyEightHoursAgo } },
          { lastMessageAt: null, createdAt: { $lt: fortyEightHoursAgo } }
        ]
      },
      { $set: { status: 'CLOSED' } }
    );

    console.log('[JOBS] HumrahRoom expiry job completed.');
  } catch (error) {
    console.error('[JOBS] Error running HumrahRoom expiry:', error);
  }
};
