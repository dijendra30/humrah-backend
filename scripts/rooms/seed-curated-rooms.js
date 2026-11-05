// scripts/rooms/seed-curated-rooms.js
// -----------------------------------------------------------------------------
// Rooms Phase 2.2 — INSERT-ONLY, idempotent seed of curated public Rooms
// (utils/curatedRoomConfig.js CURATED_ROOMS).
//
//   node scripts/rooms/seed-curated-rooms.js --mongo mongodb://127.0.0.1:27778/rooms_dev          (dry run)
//   node scripts/rooms/seed-curated-rooms.js --mongo mongodb://127.0.0.1:27778/rooms_dev --apply  (writes)
//
// Guarantees:
//   - One Room per curated key: upsert on { curatedTopicKey } with $setOnInsert ONLY,
//     backed by the partial unique index on curatedTopicKey. Re-running inserts nothing.
//   - An existing Room is never modified: no $set, no timestamps bump, no deletes.
//     A curated Room whose copy was edited later keeps its edits.
//   - No RoomMember and no RoomMessage is ever created: memberCount 0, lastMessageAt null.
//   - LOCAL DATABASES ONLY. The target must be given explicitly with --mongo and its
//     host must be 127.0.0.1 / localhost. MONGODB_URI and friends are never read.
//     Seeding production is NOT approved; it needs a separate approval and a
//     deliberate change to this guard.
// -----------------------------------------------------------------------------
'use strict';

const path = require('path');
const { CURATED_ROOMS, CURATED_ROOM_CAPACITY, CREATION_SOURCE_CURATED } = require('../../utils/curatedRoomConfig');
const { GLOBAL_TOPICS } = require('../../utils/roomTopicConfig');

const LOCAL_URI = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

/** Throws if any curated entry would break the Room schema or the honesty rules. */
function validateCuratedConfig(entries = CURATED_ROOMS) {
  const keys = new Set();
  const topics = new Set();
  for (const e of entries) {
    if (!e.key || !/^[a-z0-9-]+$/.test(e.key)) throw new Error(`bad key: ${e.key}`);
    if (keys.has(e.key)) throw new Error(`duplicate key: ${e.key}`);
    if (topics.has(e.topic)) throw new Error(`duplicate topic: ${e.topic}`);
    if (!GLOBAL_TOPICS.includes(e.topic)) throw new Error(`not a supported topic: ${e.topic}`);
    if (!e.title || e.title.length > 30) throw new Error(`title must be 1-30 chars: ${e.key}`);
    if (!e.description || e.description.length > 200) throw new Error(`description must be 1-200 chars: ${e.key}`);
    keys.add(e.key);
    topics.add(e.topic);
  }
  return true;
}

/** The exact document inserted for one curated entry. */
function curatedRoomDocument(entry, now = new Date()) {
  return {
    creationSource: CREATION_SOURCE_CURATED,
    curatedTopicKey: entry.key,
    discoveryMode: 'ALL_INDIA',
    title: entry.title,
    description: entry.description,
    topic: entry.topic,
    languages: [],
    capacity: CURATED_ROOM_CAPACITY,
    status: 'ACTIVE',
    memberCount: 0,
    lastMessageAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Seeds against an already-connected HumrahRoom model.
 * @returns {Promise<{inserted:string[], existing:string[], wouldInsert:string[], apply:boolean}>}
 */
async function seedCuratedRooms({ HumrahRoom, apply = false, entries = CURATED_ROOMS, now = new Date() }) {
  validateCuratedConfig(entries);
  // createIndexes() only ADDS missing indexes (never drops, unlike syncIndexes()).
  if (apply) await HumrahRoom.createIndexes();

  const result = { inserted: [], existing: [], wouldInsert: [], apply };
  for (const entry of entries) {
    const doc = curatedRoomDocument(entry, now);
    // Full schema validation (incl. the curated capacity rule) before anything is written.
    await new HumrahRoom(doc).validate();

    if (!apply) {
      const exists = await HumrahRoom.exists({ curatedTopicKey: entry.key });
      (exists ? result.existing : result.wouldInsert).push(entry.key);
      continue;
    }
    // Native driver call: $setOnInsert only, so a match changes NOTHING (Mongoose's
    // timestamp plugin would otherwise $set updatedAt on an existing Room).
    const r = await HumrahRoom.collection.updateOne(
      { curatedTopicKey: entry.key },
      { $setOnInsert: doc },
      { upsert: true }
    );
    (r.upsertedCount === 1 ? result.inserted : result.existing).push(entry.key);
  }
  return result;
}

async function main(argv) {
  const i = argv.indexOf('--mongo');
  const uri = i >= 0 ? argv[i + 1] : null;
  const apply = argv.includes('--apply');
  if (!uri || !LOCAL_URI.test(uri)) {
    console.error('Refusing: pass --mongo mongodb://127.0.0.1:<port>/<db>. Only local databases are allowed.');
    process.exit(2);
  }
  const mongoose = require(path.join(__dirname, '..', '..', 'node_modules', 'mongoose'));
  const HumrahRoom = require('../../models/HumrahRoom');
  await mongoose.connect(uri);
  try {
    const r = await seedCuratedRooms({ HumrahRoom, apply });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', ...r }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error('seed failed:', err.message); process.exit(1); });
}

module.exports = { seedCuratedRooms, curatedRoomDocument, validateCuratedConfig, LOCAL_URI };
