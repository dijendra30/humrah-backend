// scripts/rooms/report-room-membership-drift.js
// -----------------------------------------------------------------------------
// Rooms Phase 2.3 — READ-ONLY report of existing membership drift:
//   1. JOINED memberships whose user no longer exists (accounts deleted before the
//      Phase 2.3 fix, which left them JOINED and counted as participants);
//   2. Rooms whose denormalized memberCount differs from their real JOINED count.
//
//   node scripts/rooms/report-room-membership-drift.js --mongo <uri>
//
// Prints aggregate counts only (no ids, names, titles or messages) and performs NO
// writes: only countDocuments / aggregate, with secondaryPreferred reads. Repairing
// anything it finds is a separate, separately approved step.
// -----------------------------------------------------------------------------
'use strict';

const path = require('path');

async function report(db) {
  const members = db.collection('roommembers');
  const rooms = db.collection('humrahrooms');

  const orphanJoined = await members.aggregate([
    { $match: { status: 'JOINED' } },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
    { $match: { u: { $size: 0 } } },
    { $group: { _id: '$roomId', n: { $sum: 1 } } },
    { $group: { _id: null, memberships: { $sum: '$n' }, rooms: { $sum: 1 } } },
  ]).toArray();

  const drift = await rooms.aggregate([
    { $lookup: { from: 'roommembers', let: { rid: '$_id' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$roomId', '$$rid'] }, { $eq: ['$status', 'JOINED'] }] } } },
      { $count: 'n' }], as: 'j' } },
    { $project: { status: 1, stored: { $ifNull: ['$memberCount', 0] }, real: { $ifNull: [{ $arrayElemAt: ['$j.n', 0] }, 0] } } },
    { $match: { $expr: { $ne: ['$stored', '$real'] } } },
    { $group: { _id: { status: '$status', diff: { $subtract: ['$stored', '$real'] } }, rooms: { $sum: 1 } } },
    { $sort: { '_id.status': 1, '_id.diff': 1 } },
  ]).toArray();

  return {
    joinedMembershipsOfDeletedUsers: orphanJoined[0]?.memberships || 0,
    roomsWithSuchMemberships: orphanJoined[0]?.rooms || 0,
    roomsWhereStoredCountDiffers: drift.map(d => ({ status: d._id.status, storedMinusReal: d._id.diff, rooms: d.rooms })),
  };
}

async function main(argv) {
  const i = argv.indexOf('--mongo');
  const uri = i >= 0 ? argv[i + 1] : null;
  if (!uri) { console.error('Pass --mongo <uri>. (Read-only; prints counts only.)'); process.exit(2); }
  const { MongoClient } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongoose')).mongo;
  const client = new MongoClient(uri, { readPreference: 'secondaryPreferred', maxPoolSize: 2 });
  await client.connect();
  try {
    console.log(JSON.stringify(await report(client.db()), null, 2));
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error('report failed:', err.name); process.exit(1); });
}

module.exports = { report };
