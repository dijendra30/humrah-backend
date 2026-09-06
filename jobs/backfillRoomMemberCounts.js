// jobs/backfillRoomMemberCounts.js
// -----------------------------------------------------------------------------
// R1 one-shot, idempotent sync of HumrahRoom.memberCount (newly-introduced
// denormalized field) to the true count of JOINED RoomMember records.
//
// - Runs once at server startup.
// - Single aggregation + one bulkWrite; bounded by the number of rooms.
// - Only writes rooms whose stored memberCount is missing or wrong.
// - Safe to run repeatedly (a correct DB → zero writes).
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');

async function backfillRoomMemberCounts() {
  try {
    const counts = await RoomMember.aggregate([
      { $match: { status: 'JOINED' } },
      { $group: { _id: '$roomId', c: { $sum: 1 } } },
    ]);
    const countByRoom = new Map(counts.map(x => [String(x._id), x.c]));

    const rooms = await HumrahRoom.find({}).select('_id memberCount').lean();
    const ops = [];
    for (const room of rooms) {
      const actual = countByRoom.get(String(room._id)) || 0;
      if (room.memberCount !== actual) {
        ops.push({
          updateOne: {
            filter: { _id: room._id },
            update: { $set: { memberCount: actual } },
          },
        });
      }
    }

    if (ops.length > 0) {
      await HumrahRoom.bulkWrite(ops, { ordered: false });
    }
    console.log(`[BACKFILL] room memberCount synced — ${rooms.length} rooms checked, ${ops.length} corrected.`);
  } catch (err) {
    console.error('[BACKFILL] room memberCount backfill failed (non-fatal):', err.message);
  }
}

module.exports = { backfillRoomMemberCounts };
