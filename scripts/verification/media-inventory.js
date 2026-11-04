// READ-ONLY inventory of stored verification videos (step 1 of the migration plan).
// Prints counts only: no user ids, names, emails, public ids or URLs. Contains no write operation.
//   node scripts/verification/media-inventory.js        (uses MONGODB_URI from the environment)
'use strict';
const { MongoClient } = require('mongoose').mongo;

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(2); }
  const client = new MongoClient(uri, { readPreference: 'secondaryPreferred', maxPoolSize: 2 });
  await client.connect();
  const S = client.db().collection('verificationsessions');
  const withMedia = { cloudinaryPublicId: { $nin: [null, ''] } };
  const typeOf = { $cond: [{ $regexMatch: { input: { $ifNull: ['$videoUrl', ''] }, regex: '/video/authenticated/' } }, 'authenticated',
    { $cond: [{ $regexMatch: { input: { $ifNull: ['$videoUrl', ''] }, regex: '/video/upload/' } }, 'public(upload)', 'unknown(videoUrl missing)'] }] };
  const rows = await S.aggregate([
    { $match: withMedia },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
    { $project: { status: 1, type: typeOf, userExists: { $gt: [{ $size: '$u' }, 0] } } },
    { $group: { _id: { status: '$status', type: '$type', userExists: '$userExists' }, n: { $sum: 1 } } },
    { $sort: { '_id.status': 1 } }
  ]).toArray();
  console.log('Sessions still referencing a verification video:');
  for (const r of rows) console.log(`  status=${r._id.status.padEnd(13)} storage=${r._id.type.padEnd(26)} userExists=${r._id.userExists}  count=${r.n}`);
  console.log(`  total=${rows.reduce((a, r) => a + r.n, 0)}`);
  await client.close();
})().catch(e => { console.error('ERROR', e.name, e.code || ''); process.exit(1); });
