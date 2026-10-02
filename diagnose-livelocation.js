#!/usr/bin/env node
// Sports Discovery incident MongoServerError 291 — READ-ONLY diagnostic for the users collection.
//
// It answers two questions without changing anything:
//   1. Does users have the { liveLocation: "2dsphere" } index that the discovery candidate query ($near) needs?
//   2. Would building that index fail? (MongoDB refuses to build it if ANY user holds a liveLocation that is
//      not valid GeoJSON, and Mongoose's automatic index build hides that failure.)
//
// Operations used: listIndexes, countDocuments, and (only with --show-ids) find({...}, {_id: 1}).limit(5).
// No insert, update, delete, index creation or index drop. Use a READ-ONLY database user if you can.
//
//   node <path>\SPORTS_DISCOVERY_291_KIT\diagnose-livelocation.js [--db <name>] [--show-ids]
//
// It runs from ANY folder: it uses the mongoose already installed in the Humrah backend (HUMRAH_BACKEND_DIR, else the
// current folder, else C:\Users\DIJENDRA\Desktop\humrah-backend-main). Nothing is installed.
//
// The connection string: if HUMRAH_DIAG_MONGO_URI is set it is used; otherwise the script ASKS for it with a hidden
// prompt (nothing is echoed, so it never appears on screen, in shell history or in a log, and characters like & need no
// quoting). It is never printed, and errors show only their name and code. There is deliberately no --uri option.
//
// Exit code: 0 = index present, or absent but buildable; 1 = absent AND at least one document would block the build;
// 2 = could not run.
'use strict';
const path = require('path');

const DEFAULT_BACKEND = 'C:\\Users\\DIJENDRA\\Desktop\\humrah-backend-main';

/** The backend's own mongoose: no second copy is installed. Returns { mongoose, from } or throws a clear error. */
function loadBackendMongoose() {
  const candidates = [process.env.HUMRAH_BACKEND_DIR, process.cwd(), DEFAULT_BACKEND].filter(Boolean);
  for (const dir of candidates) {
    try { return { mongoose: require(require.resolve('mongoose', { paths: [dir] })), from: dir }; }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  const err = new Error('mongoose not found in: ' + candidates.join(' ; ') + '. Run "npm ci" in the backend folder, or set HUMRAH_BACKEND_DIR to it.');
  err.code = 'MONGOOSE_NOT_FOUND';
  throw err;
}

/** Read one line without echoing it. Only from an interactive terminal. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { reject(Object.assign(new Error('no terminal to ask in; set HUMRAH_DIAG_MONGO_URI instead'), { code: 'NO_TTY' })); return; }
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (err) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); err ? reject(err) : resolve(value); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));   // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') value = value.slice(0, -1);                                // Backspace
        else if (ch >= ' ') value += ch;                                                                    // printable (paste works)
      }
    };
    stdin.on('data', onData);
  });
}

// A valid GeoJSON Point: exactly what liveLocationService.updateUserLiveLocation writes.
const VALID_POINT = {
  'liveLocation.type': 'Point',
  'liveLocation.coordinates': { $size: 2 },
  'liveLocation.coordinates.0': { $gte: -180, $lte: 180 },
  'liveLocation.coordinates.1': { $gte: -90, $lte: 90 },
};
// An object with no "type": MongoDB reads it as a LEGACY coordinate pair, FIRST field = longitude.
// Mongoose stores { lat, lng, ... } in that order, so lat is read as the longitude and lng as the latitude.
const NO_TYPE = { liveLocation: { $type: 'object' }, 'liveLocation.type': { $exists: false } };
const LEGACY_OK = { ...NO_TYPE, 'liveLocation.coordinates': { $exists: false },
  'liveLocation.lat': { $gte: -180, $lte: 180 }, 'liveLocation.lng': { $gte: -90, $lte: 90 } };

const CLASSES = [
  // [id, meaning, filter, blocksTheBuild]
  ['validPoint', 'valid GeoJSON Point', VALID_POINT, false],
  ['badPoint', 'has "type" but is not a valid Point (no/empty/out-of-range coordinates, or another type)',
    { 'liveLocation.type': { $exists: true }, $nor: [VALID_POINT] }, true],
  ['noTypeWithCoordinates', 'no "type" but has "coordinates"', { ...NO_TYPE, 'liveLocation.coordinates': { $exists: true } }, true],
  ['legacyLatLngReadable', 'no "type", {lat, lng} object that MongoDB CAN read (as a swapped point: lat taken as longitude)', LEGACY_OK, false],
  ['legacyLatLngBlocking', 'no "type", {lat, lng} object MongoDB CANNOT read (lat/lng null or missing, or lng beyond ±90 e.g. east of 90°E)',
    { ...NO_TYPE, 'liveLocation.coordinates': { $exists: false }, $nor: [LEGACY_OK] }, true],
  ['nonObject', 'liveLocation is set but is not an object (e.g. a string)', { liveLocation: { $exists: true, $not: { $type: ['object', 'null', 'array'] } } }, true],
];

async function diagnose(db, { showIds = false } = {}) {
  const users = db.collection('users');
  const indexes = await users.indexes();
  const geo = indexes.find(i => JSON.stringify(i.key) === JSON.stringify({ liveLocation: '2dsphere' }));
  const out = { indexPresent: !!geo, indexName: geo ? geo.name : null, indexes: indexes.map(i => ({ name: i.name, key: i.key })), total: await users.countDocuments({}), classes: {} };
  let blocking = 0;
  for (const [id, meaning, filter, blocks] of CLASSES) {
    const n = await users.countDocuments(filter);
    const row = { count: n, meaning, blocksTheBuild: blocks };
    if (showIds && n > 0 && id !== 'validPoint') row.sampleIds = (await users.find(filter, { projection: { _id: 1 } }).limit(5).toArray()).map(d => String(d._id));
    out.classes[id] = row;
    if (blocks) blocking += n;
  }
  out.blockingDocuments = blocking;
  out.buildable = blocking === 0;
  return out;
}

module.exports = { diagnose, CLASSES };

if (require.main === module) {
  (async () => {
    if (process.argv.some(a => /^--uri/.test(a) || /^mongodb(\+srv)?:\/\//i.test(a))) {
      console.error('Do not put the connection string on the command line (it would land in shell history). Run without it and paste it at the hidden prompt.');
      process.exitCode = 2; return;
    }
    const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
    const { mongoose, from } = loadBackendMongoose();          // fail before asking for anything if mongoose is missing
    console.log(`using mongoose ${mongoose.version} from ${from}`);
    let uri = process.env.HUMRAH_DIAG_MONGO_URI;
    if (uri) console.log('connection string: taken from HUMRAH_DIAG_MONGO_URI (not shown)');
    else uri = (await askHidden('Paste the READ-ONLY connection string (hidden), then press Enter: ')).trim();
    if (!/^mongodb(\+srv)?:\/\//i.test(uri || '')) { console.error('That is not a mongodb:// or mongodb+srv:// connection string (not shown).'); process.exitCode = 2; return; }
    const conn = await mongoose.createConnection(uri, { ...(arg('--db') ? { dbName: arg('--db') } : {}), serverSelectionTimeoutMS: 15000 }).asPromise();
    uri = null;
    try {
      const r = await diagnose(conn.db, { showIds: process.argv.includes('--show-ids') });
      console.log(`database: ${conn.db.databaseName}   users: ${r.total}`);
      console.log(`users { liveLocation: "2dsphere" } index: ${r.indexPresent ? 'PRESENT (' + r.indexName + ')' : 'MISSING'}`);
      console.log('all users indexes: ' + r.indexes.map(i => i.name).join(', '));
      console.log('\nliveLocation shapes:');
      for (const [id, row] of Object.entries(r.classes)) console.log(`  ${String(row.count).padStart(7)}  ${row.blocksTheBuild ? 'BLOCKS the build ' : 'ok for the build '}  ${id}: ${row.meaning}${row.sampleIds ? '   e.g. ' + row.sampleIds.join(', ') : ''}`);
      if (r.indexPresent) console.log('\nRESULT: the index exists. The 291 error is not caused by a missing index; do not create anything.');
      else if (r.buildable) console.log('\nRESULT: the index is missing and NO document blocks it: it can be built (see README, step 4).');
      else console.log(`\nRESULT: the index is missing and ${r.blockingDocuments} document(s) would make the build fail. Do NOT create it yet (see README).`);
      if (r.classes.legacyLatLngReadable.count > 0) console.log(`NOTE: ${r.classes.legacyLatLngReadable.count} user(s) hold a {lat, lng} object without "type": the index can be built, but those users are indexed at a SWAPPED point and will never be within 10 km of a plan until their location is next updated by the app.`);
      process.exitCode = r.indexPresent || r.buildable ? 0 : 1;
    } finally { await conn.close(); }
  })().catch(e => {
    // Our own errors carry no secret; a driver error can contain a host or user name, so only its name and code are shown.
    const own = ['MONGOOSE_NOT_FOUND', 'NO_TTY', 'CANCELLED'].includes(e.code);
    console.error('could not run:', own ? e.message : `${e.name} ${e.code || e.codeName || ''}`.trim());
    process.exitCode = 2;
  });
}
