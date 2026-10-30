// scripts/checkMoodChatIndexes.js
// -----------------------------------------------------------------------------
// OPTIONAL safety check for "one-to-one chats never expire".
//
// The code no longer closes or hides a chat because of its age. The MoodChat schema
// has never declared a TTL index, so MongoDB should not be deleting chats either —
// but an index created by hand in the past would still delete them. This lists the
// indexes on `moodchats` and, ONLY with --apply, drops a TTL index on { expiresAt: 1 }
// (found by key AND expireAfterSeconds). Nothing else is touched; no document is
// changed or deleted. Sports, Movie Hangout and every other collection are not read.
//
//   node scripts/checkMoodChatIndexes.js            # report only
//   node scripts/checkMoodChatIndexes.js --apply    # drop that one TTL index, if present
// -----------------------------------------------------------------------------
'use strict';
try { require('dotenv').config(); } catch (_) { /* env already set */ }
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(2); }
  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection('moodchats');
  const indexes = await col.indexes();
  console.log(`[moodchats] indexes: ${indexes.map(i => `${i.name}${typeof i.expireAfterSeconds === 'number' ? ` (TTL ${i.expireAfterSeconds}s)` : ''}`).join(', ')}`);
  const ttl = indexes.filter(ix => ix.key && Object.keys(ix.key).length === 1 && ix.key.expiresAt === 1 && typeof ix.expireAfterSeconds === 'number');
  if (!ttl.length) {
    console.log('[moodchats] no TTL index on expiresAt — chats are not being auto-deleted. Nothing to do.');
  } else {
    for (const ix of ttl) {
      if (APPLY) { await col.dropIndex(ix.name); console.log(`[moodchats] dropped TTL index ${ix.name}.`); }
      else console.log(`[moodchats] TTL index ${ix.name} found — run with --apply to drop it.`);
    }
  }
  await mongoose.disconnect();
}

main().catch(async err => {
  console.error('[moodchats] failed:', err.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
