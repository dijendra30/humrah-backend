// scripts/migrateMovieChatLifetime.js
// -----------------------------------------------------------------------------
// ONE-TIME migration for the Movie Hangout chat lifetime (movieChatLifetime.js).
//
// 1. Removes the old TTL index on moviesessions { expiresAt: 1 } (expireAfterSeconds),
//    which made MongoDB delete every hangout — and with it its chat — 24 hours after
//    its card ended. Only that one index is touched; it is found by its key AND its
//    TTL option, never by guessing a name.
// 2. Backfills MovieSession.lastMessageAt (where missing) from each hangout's newest
//    member message, so chats that were already talking get their full 7 days from
//    that message instead of from the showtime.
//
// SAFE BY DEFAULT: without --apply it only reports what it would do and changes
// nothing. Running it again after --apply finds nothing left to do.
//
//   node scripts/migrateMovieChatLifetime.js            # dry run (reads only)
//   node scripts/migrateMovieChatLifetime.js --apply    # make the two changes
//
// Uses MONGODB_URI from the environment (or .env), like server.js. Nothing is deleted
// except the index itself; no document is removed or rewritten beyond lastMessageAt.
// -----------------------------------------------------------------------------
'use strict';
try { require('dotenv').config(); } catch (_) { /* env already set */ }
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(2); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`[migrate] connected to database "${db.databaseName}" — ${APPLY ? 'APPLY' : 'DRY RUN (no changes)'}`);

  // ── 1. The TTL index ───────────────────────────────────────────────────────
  const sessions = db.collection('moviesessions');
  const indexes = await sessions.indexes();
  const ttl = indexes.filter(ix =>
    ix.key && Object.keys(ix.key).length === 1 && ix.key.expiresAt === 1 && typeof ix.expireAfterSeconds === 'number');
  console.log(`[migrate] moviesessions indexes: ${indexes.map(i => i.name).join(', ')}`);
  if (ttl.length === 0) {
    console.log('[migrate] TTL index on expiresAt: not present (already removed) — nothing to do.');
  } else {
    for (const ix of ttl) {
      console.log(`[migrate] TTL index found: ${ix.name} (expireAfterSeconds=${ix.expireAfterSeconds})`);
      if (APPLY) {
        await sessions.dropIndex(ix.name);
        console.log(`[migrate]   → dropped ${ix.name}. Hangouts are no longer auto-deleted.`);
      } else {
        console.log(`[migrate]   → would drop ${ix.name}.`);
      }
    }
  }

  // ── 2. Backfill lastMessageAt ──────────────────────────────────────────────
  const missing = await sessions.find({ lastMessageAt: { $in: [null] } }).project({ _id: 1 }).toArray();
  const ids = missing.map(s => s._id);
  let filled = 0;
  if (ids.length) {
    const newest = await db.collection('moviemessages').aggregate([
      { $match: { sessionId: { $in: ids }, senderId: { $ne: null }, type: { $in: ['text', 'voice'] } } },
      { $group: { _id: '$sessionId', last: { $max: '$createdAt' } } },
    ]).toArray();
    console.log(`[migrate] hangouts without lastMessageAt: ${ids.length}; with member messages to backfill from: ${newest.length}`);
    if (APPLY) {
      for (const row of newest) {
        const r = await sessions.updateOne(
          { _id: row._id, lastMessageAt: { $in: [null] } },
          { $set: { lastMessageAt: row.last } },
        );
        filled += r.modifiedCount;
      }
      console.log(`[migrate]   → backfilled lastMessageAt on ${filled} hangout(s).`);
    } else {
      console.log(`[migrate]   → would backfill ${newest.length} hangout(s).`);
    }
  } else {
    console.log('[migrate] every hangout already has lastMessageAt — nothing to backfill.');
  }

  await mongoose.disconnect();
  console.log(`[migrate] done${APPLY ? '' : ' (dry run — re-run with --apply to make these changes)'}.`);
}

main().catch(async err => {
  console.error('[migrate] failed:', err.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
