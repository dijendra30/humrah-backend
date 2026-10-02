#!/usr/bin/env node
// Sports Discovery incident MongoServerError 291 — READ-ONLY inspection of ONE users document whose liveLocation blocks
// the { liveLocation: "2dsphere" } index build.
//
//   Inside the backend container (Coolify terminal):   node /app/inspect-livelocation-user.js <userId>
//
// It reads that ONE document (location fields only) and prints its liveLocation SHAPE: field order, BSON types, null /
// numeric / range classes. It never prints a coordinate, a city, a place name or any other personal field: ranges are
// shown as classes ("within [-90, 90]", "beyond +-90 but within +-180"). It then says which repair, if any, is safe, and
// prints that operation for a human to run; it never runs it.
//
// Operations used: listCollections, findOne / aggregate on that one _id, countDocuments. No insert, update, delete,
// index creation or index drop. Connection string and mongoose exactly as diagnose-livelocation.js:
// HUMRAH_DIAG_MONGO_URI, else MONGODB_URI (the backend's own variable), never printed; autoIndex/autoCreate off.
//
// Exit code: 0 = nothing to repair (already valid GeoJSON); 1 = a repair is needed and is printed; 3 = needs a manual
// decision (no safe automatic repair); 2 = could not determine (no connection, no users collection, no such user, error).
'use strict';

const DEFAULT_BACKEND = 'C:\\Users\\DIJENDRA\\Desktop\\humrah-backend-main';
const BACKEND_URI_VAR = 'MONGODB_URI';

function loadBackendMongoose() {
  const candidates = [process.env.HUMRAH_BACKEND_DIR, __dirname, process.cwd(), '/app', DEFAULT_BACKEND].filter(Boolean);
  for (const dir of candidates) {
    try { return { mongoose: require(require.resolve('mongoose', { paths: [dir] })), from: dir }; }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw Object.assign(new Error('mongoose not found in: ' + candidates.join(' ; ')), { code: 'MONGOOSE_NOT_FOUND' });
}

const DAY = 24 * 60 * 60 * 1000;
const isNum = v => typeof v === 'number';
const daysAgo = (d, now) => (d instanceof Date && !isNaN(d)) ? `${Math.max(0, Math.floor((now - d) / DAY))} day(s) ago` : (d === null ? 'null' : d === undefined ? 'missing' : 'not a date');

/** A class for a stored latitude/longitude value. Never the value itself. */
function valueClass(present, v) {
  if (!present) return 'missing';
  if (v === null) return 'null';
  if (!isNum(v)) return 'not a number';
  if (!Number.isFinite(v)) return 'NaN or infinite';
  if (v >= -90 && v <= 90) return 'within [-90, 90]';
  if (v >= -180 && v <= 180) return 'beyond +-90 but within [-180, 180]';
  return 'outside [-180, 180]';
}

/** How MongoDB's 2dsphere build reads this liveLocation, and whether it can index it. */
function mongoReading(ll, keys) {
  if (ll === null || ll === undefined) return { indexable: true, how: 'no liveLocation: the document is skipped by the index' };
  if (typeof ll !== 'object' || Array.isArray(ll)) return { indexable: false, how: 'not an object' };
  if ('type' in ll) {
    const c = ll.coordinates;
    const ok = ll.type === 'Point' && Array.isArray(c) && c.length === 2 && isNum(c[0]) && isNum(c[1]) && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90;
    return { indexable: ok, how: ok ? 'GeoJSON Point' : 'has "type" but is not a valid GeoJSON Point' };
  }
  // No "type": a LEGACY coordinate pair, made of the FIRST two fields in stored order: first = longitude, second = latitude.
  const [f1, f2] = keys;
  const v1 = ll[f1], v2 = ll[f2];
  const ok = keys.length >= 2 && isNum(v1) && isNum(v2) && v1 >= -180 && v1 <= 180 && v2 >= -90 && v2 <= 90;
  return { indexable: ok, how: `no "type": read as a LEGACY pair, longitude = "${f1}", latitude = "${f2}"` + (ok ? '' : ' -> cannot be read as a point') };
}

function repairFor(id, ll, keys) {
  const hasType = 'type' in ll, hasCoords = 'coordinates' in ll;
  const lat = ll.lat, lng = ll.lng;
  const latOk = isNum(lat) && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const lngOk = isNum(lng) && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  const absent = v => v === null || v === undefined;
  const guard = `_id: ObjectId("${id}"), "liveLocation.type": { $exists: false }, "liveLocation.coordinates": { $exists: false }`;
  if (!hasType && !hasCoords && latOk && lngOk) {
    return {
      kind: 'REBUILD_FROM_STORED_LAT_LNG',
      why: 'lat and lng are stored, numeric and valid; only "type" and "coordinates" are missing. The repair copies the document\'s OWN lat/lng into ' +
        'coordinates [lng, lat], which is exactly what services/liveLocationService.js writes. No value is typed, guessed or taken from elsewhere; ' +
        'updatedAt, city, state and every other field stay as they are, so the location does not become "fresh".',
      op:
`db.users.updateOne(
  { ${guard},
    "liveLocation.lat": { $type: "number", $gte: -90, $lte: 90 },
    "liveLocation.lng": { $type: "number", $gte: -180, $lte: 180 } },
  [ { $set: { liveLocation: { $mergeObjects: [ { type: "Point", coordinates: [ "$liveLocation.lng", "$liveLocation.lat" ] }, "$liveLocation" ] } } } ]
)`,
    };
  }
  if (!hasType && !hasCoords && absent(lat) && absent(lng)) {
    return {
      kind: 'SCHEMA_DEFAULT_NO_LOCATION',
      why: 'no latitude/longitude is stored: there is no location to reconstruct. The repair adds the User schema\'s own defaults ' +
        '(type "Point", coordinates [0, 0]) — exactly what every brand-new user holds before the app sends a location. lat/lng stay null, ' +
        'so nothing treats the user as located; the app writes a real location on the next app open.',
      op:
`db.users.updateOne(
  { ${guard},
    "liveLocation.lat": null, "liveLocation.lng": null },
  { $set: { "liveLocation.type": "Point", "liveLocation.coordinates": [0, 0] } }
)`,
    };
  }
  return { kind: 'MANUAL_DECISION', why: 'this shape is not one of the two safe cases (valid lat+lng, or no lat and no lng). Do not repair automatically; send this output.', op: null };
}

if (require.main === module) {
  (async () => {
    const id = process.argv[2];
    if (!/^[0-9a-f]{24}$/i.test(id || '')) { console.error('usage: node inspect-livelocation-user.js <24-hex userId>'); process.exitCode = 2; return; }
    if (process.argv.some(a => /^mongodb(\+srv)?:\/\//i.test(a))) { console.error('Do not put the connection string on the command line.'); process.exitCode = 2; return; }
    const { mongoose, from } = loadBackendMongoose();
    console.log(`using mongoose ${mongoose.version} from ${from}`);
    let uri;
    if (process.env.HUMRAH_DIAG_MONGO_URI) { uri = process.env.HUMRAH_DIAG_MONGO_URI; console.log('connection string: taken from HUMRAH_DIAG_MONGO_URI (not shown)'); }
    else if (process.env[BACKEND_URI_VAR]) { uri = process.env[BACKEND_URI_VAR]; console.log(`connection string: using existing backend MongoDB configuration (${BACKEND_URI_VAR}, not shown)`); }
    else { console.error(`could not run: neither HUMRAH_DIAG_MONGO_URI nor ${BACKEND_URI_VAR} is set`); process.exitCode = 2; return; }
    if (!/^mongodb(\+srv)?:\/\//i.test(uri)) { console.error('could not run: not a mongodb connection string (not shown)'); process.exitCode = 2; return; }
    const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false, autoCreate: false }).asPromise();
    uri = null;
    try {
      const db = conn.db;
      if ((await db.listCollections({ name: 'users' }, { nameOnly: true }).toArray()).length === 0) {
        console.error('could not run: the configured database has no "users" collection (nothing concluded).'); process.exitCode = 2; return;
      }
      const users = db.collection('users');
      const _id = new mongoose.Types.ObjectId(id);
      const now = Date.now();
      // Only location-related fields, plus status and lastActive (to judge whether the user can refresh from the app).
      const doc = await users.findOne({ _id }, { projection: { liveLocation: 1, last_known_lat: 1, last_known_lng: 1, last_location_updated_at: 1, lastActive: 1, status: 1 } });
      if (!doc) { console.error('could not run: no user with that _id (nothing concluded).'); process.exitCode = 2; return; }
      // Exact stored field order and BSON types, from the server itself.
      const [t] = await users.aggregate([{ $match: { _id } }, { $project: {
        _id: 0, llType: { $type: '$liveLocation' },
        fields: { $cond: [{ $eq: [{ $type: '$liveLocation' }, 'object'] }, { $map: { input: { $objectToArray: '$liveLocation' }, in: { k: '$$this.k', t: { $type: '$$this.v' } } } }, []] },
      } }]).toArray();

      const ll = doc.liveLocation;
      console.log(`\nuser ${id}: found`);
      console.log(`account status: ${doc.status ?? 'missing'}   last active: ${daysAgo(doc.lastActive, now)}`);
      console.log(`\n1. liveLocation BSON type: ${t.llType}`);
      if (t.llType !== 'object') {
        console.log('   (not an object)');
      }
      const keys = t.fields.map(f => f.k);
      console.log('   stored fields, in order: ' + (t.fields.map(f => `${f.k}:${f.t}`).join(', ') || '(none)'));
      if (t.llType === 'object') {
        console.log(`   "type": ${'type' in ll ? 'present' : 'MISSING'}    "coordinates": ${'coordinates' in ll ? 'present' : 'MISSING'}`);
        console.log(`2-6. lat: ${'lat' in ll ? 'present' : 'missing'}, ${valueClass('lat' in ll, ll.lat)}`);
        console.log(`     lng: ${'lng' in ll ? 'present' : 'missing'}, ${valueClass('lng' in ll, ll.lng)}`);
        if (isNum(ll.lat) && isNum(ll.lng)) console.log(`     lat/lng inside India's bounding box (lat 6..38, lng 68..98): ${ll.lat >= 6 && ll.lat <= 38 && ll.lng >= 68 && ll.lng <= 98 ? 'yes' : 'no'}`);
        console.log(`     city: ${ll.city ? 'set' : 'not set'}   state: ${ll.state ? 'set' : 'not set'}   displayName: ${ll.displayName ? 'set' : 'not set'}   (values not shown)`);
        console.log(`     liveLocation.updatedAt: ${daysAgo(ll.updatedAt, now)}`);
        const r = mongoReading(ll, keys);
        console.log(`7. how the 2dsphere build reads it: ${r.how}`);
        if (!('type' in ll) && keys.length >= 2) {
          console.log(`   legacy reading: longitude ("${keys[0]}") ${valueClass(true, ll[keys[0]])}; latitude ("${keys[1]}") ${valueClass(true, ll[keys[1]])} -> ${r.indexable ? 'readable' : (isNum(ll[keys[0]]) && isNum(ll[keys[1]]) ? 'REJECTED: a latitude must be within [-90, 90]' : 'REJECTED: not numeric')}`);
        }
        console.log(`   indexable: ${r.indexable ? 'yes' : 'NO — this document makes the index build fail'}`);
      }

      // 8. The other location fields in the same document. Compared, never printed.
      const kLat = doc.last_known_lat, kLng = doc.last_known_lng;
      console.log(`\n8. last_known_lat: ${valueClass('last_known_lat' in doc, kLat)}   last_known_lng: ${valueClass('last_known_lng' in doc, kLng)}   last_location_updated_at: ${daysAgo(doc.last_location_updated_at, now)}`);
      if (ll && typeof ll === 'object' && isNum(ll.lat) && isNum(kLat)) {
        console.log(`   last_known_* equal to liveLocation lat/lng: ${kLat === ll.lat && kLng === ll.lng ? 'yes, exactly' : 'NO (they differ)'}`);
        const a = ll.updatedAt, b = doc.last_location_updated_at;
        if (a instanceof Date && b instanceof Date) console.log(`   written in the same update (timestamps within 5 s): ${Math.abs(a - b) <= 5000 ? 'yes' : 'no'}`);
      }

      // Confirm, at run time, that this is still the ONLY blocking document.
      try {
        const { CLASSES } = require(require('path').join(__dirname, 'diagnose-livelocation.js'));
        let blocking = 0; const per = [];
        for (const [cid, , filter, blocks] of CLASSES) if (blocks) { const n = await users.countDocuments(filter); blocking += n; if (n) per.push(`${cid} ${n}`); }
        const thisOne = await users.countDocuments({ _id, $or: CLASSES.filter(c => c[3]).map(c => c[2]) });
        console.log(`\nwhole collection now: ${blocking} blocking document(s)${per.length ? ' (' + per.join(', ') + ')' : ''}; this user among them: ${thisOne ? 'yes' : 'no'}`);
      } catch (e) { console.log('\n(diagnose-livelocation.js not next to this script: collection-wide recount skipped)'); }
      // Informational, never blocking: valid Points whose coordinates disagree with lat/lng (left by the partial
      // 'liveLocation.lat/lng' writers in routes/randomBooking.js). They index fine but sit at their older point.
      const stale = await users.countDocuments({ 'liveLocation.type': 'Point', 'liveLocation.lat': { $type: 'number' }, 'liveLocation.lng': { $type: 'number' },
        $expr: { $or: [{ $ne: [{ $arrayElemAt: ['$liveLocation.coordinates', 0] }, '$liveLocation.lng'] }, { $ne: [{ $arrayElemAt: ['$liveLocation.coordinates', 1] }, '$liveLocation.lat'] }] } });
      console.log(`informational: valid Points whose coordinates differ from their lat/lng: ${stale} (not blocking)`);

      // Verdict.
      if (ll && typeof ll === 'object' && !Array.isArray(ll) && mongoReading(ll, keys).indexable && 'type' in ll) {
        console.log('\nRESULT: ALREADY_VALID — this liveLocation is now a valid GeoJSON Point (the app has refreshed it). Repair nothing; re-run diagnose-livelocation.js.');
        process.exitCode = 0; return;
      }
      if (!ll || typeof ll !== 'object' || Array.isArray(ll)) {
        console.log('\nRESULT: MANUAL_DECISION — liveLocation is not an object. Do not repair automatically; send this output.');
        process.exitCode = 3; return;
      }
      const rep = repairFor(id, ll, keys);
      console.log(`\nRESULT: ${rep.kind}\n${rep.why}`);
      if (rep.op) {
        console.log('\nThe ONE operation that repairs it (NOT run by this script; run it only when you decide, BEFORE creating the index):\n');
        console.log(rep.op);
        console.log('\nExpected: { matchedCount: 1, modifiedCount: 1 }. matchedCount 0 means the document changed since (e.g. the app refreshed it): re-run this script.');
        process.exitCode = 1;
      } else process.exitCode = 3;
    } finally { await conn.close(); }
  })().catch(e => {
    const own = ['MONGOOSE_NOT_FOUND'].includes(e.code);
    console.error('could not run:', own ? e.message : `${e.name} ${e.code || e.codeName || ''}`.trim());
    process.exitCode = 2;
  });
}

module.exports = { valueClass, mongoReading, repairFor };
