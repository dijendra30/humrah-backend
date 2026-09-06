// scripts/diagnose_room_generation.js
// -----------------------------------------------------------------------------
// READ-ONLY diagnostic for "the generator is enabled but no System Rooms appear".
//
// Walks the exact same funnel the generator walks and reports where it empties out.
// It creates nothing, updates nothing, deletes nothing, and sends no notification.
// It prints counts only — no names, emails, phone numbers, tokens or free text.
//
//   node scripts/diagnose_room_generation.js
//
// Requires MONGODB_URI in the environment / .env (the same cluster Compass shows).
// -----------------------------------------------------------------------------
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('Connected.\n');

  const User = require('../models/User');
  const HumrahRoom = require('../models/HumrahRoom');
  const RoomMember = require('../models/RoomMember');
  const { loadRoomCandidates, bucketCandidatesByCity, cityKeyOf } = require('../services/roomCandidateService');
  const { CONFIG } = require('../services/systemRoomGeneratorService');
  const matching = require('../services/roomMatchingService');

  const line = (label, value) => console.log(`  ${String(label).padEnd(46)} ${value}`);

  // ── Stage 0: raw population ────────────────────────────────────────────────
  console.log('STAGE 0 — user population');
  const total = await User.countDocuments({});
  const active = await User.countDocuments({ status: 'ACTIVE' });
  const notSuspended = await User.countDocuments({ status: 'ACTIVE', 'suspensionInfo.isSuspended': { $ne: true } });
  const notCompanion = await User.countDocuments({
    status: 'ACTIVE', 'suspensionInfo.isSuspended': { $ne: true }, userType: { $ne: 'COMPANION' },
  });
  const withInterests = await User.countDocuments({
    status: 'ACTIVE', 'suspensionInfo.isSuspended': { $ne: true }, userType: { $ne: 'COMPANION' },
    'questionnaire.humrahRoomInterests.0': { $exists: true },
  });
  line('total users', total);
  line('ACTIVE', active);
  line('  ...not suspended', notSuspended);
  line('  ...not COMPANION', notCompanion);
  line('  ...with humrahRoomInterests (Q24) <-- THE GATE', withInterests);
  if (withInterests < CONFIG.MIN_GROUP_SIZE) {
    console.log(`\n  >>> DEAD END: the generator needs at least ${CONFIG.MIN_GROUP_SIZE} users who have answered Q24.`);
    console.log('      Nothing is wrong with the code. Rooms cannot be generated until more');
    console.log('      users answer the "what would you like a Humrah Room about?" question.\n');
  }

  // ── Stage 1: candidate loading (the real function) ─────────────────────────
  console.log('\nSTAGE 1 — loadRoomCandidates()');
  const { candidates, stats } = await loadRoomCandidates();
  Object.entries(stats).forEach(([k, v]) => line(k, v));

  if (candidates.length === 0) {
    console.log('\n  >>> No eligible candidates. Stopping.\n');
    await mongoose.disconnect();
    return;
  }

  // ── Stage 2: city bucketing ────────────────────────────────────────────────
  console.log('\nSTAGE 2 — bucketCandidatesByCity()');
  const { cityBatches, allIndiaPool } = bucketCandidatesByCity(candidates, {
    minGroupSize: CONFIG.MIN_GROUP_SIZE, cityBatchSize: 60,
  });
  line('candidates with a city on file', candidates.filter(cityKeyOf).length);
  line('NEAR_ME city batches (>= min group size)', cityBatches.length);
  cityBatches.forEach(b => line(`  city batch size`, b.users.length));
  line('ALL_INDIA pool', allIndiaPool.length);

  // ── Stage 3: pairwise compatibility across the whole pool ──────────────────
  console.log('\nSTAGE 3 — pairwise compatibility');
  line('thresholds', `pairwise >= ${CONFIG.MIN_PAIRWISE_SCORE}, cohesion >= ${CONFIG.MIN_COHESION_SCORE}, evidence >= ${CONFIG.MIN_EVIDENCE_CONFIDENCE}`);

  const pool = candidates.slice(0, 200);
  let pairs = 0, eligiblePairs = 0, passingPairs = 0, best = 0;
  const buckets = { '0-39': 0, '40-59': 0, '60-69': 0, '70-79': 0, '80+': 0 };
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      pairs++;
      let p;
      try { p = matching.calculatePairwiseCompatibility(pool[i], pool[j]); } catch (_) { continue; }
      if (p.eligible) eligiblePairs++;
      const s = p.overallScore || 0;
      if (s > best) best = s;
      if (s >= 80) buckets['80+']++;
      else if (s >= 70) buckets['70-79']++;
      else if (s >= 60) buckets['60-69']++;
      else if (s >= 40) buckets['40-59']++;
      else buckets['0-39']++;
      if (p.eligible && s >= CONFIG.MIN_PAIRWISE_SCORE) passingPairs++;
    }
  }
  line('pairs compared', pairs);
  line('pairs marked eligible', eligiblePairs);
  line(`pairs scoring >= ${CONFIG.MIN_PAIRWISE_SCORE}  <-- groups need these`, passingPairs);
  line('best score seen', best);
  console.log('  score distribution:');
  Object.entries(buckets).forEach(([k, v]) => line(`    ${k}`, v));

  if (passingPairs === 0) {
    console.log(`\n  >>> DEAD END: no two candidates are compatible enough to seed a Room.`);
    console.log(`      Best pair scored ${best} against a required ${CONFIG.MIN_PAIRWISE_SCORE}.\n`);
  }

  // ── Stage 4: what already exists ───────────────────────────────────────────
  console.log('\nSTAGE 4 — existing Rooms');
  const byStatus = await HumrahRoom.aggregate([
    { $group: { _id: { status: '$status', source: '$creationSource' }, n: { $sum: 1 } } },
  ]);
  if (byStatus.length === 0) line('rooms', 0);
  byStatus.forEach(r => line(`${r._id.source} / ${r._id.status}`, r.n));
  line('INVITED memberships outstanding', await RoomMember.countDocuments({ status: 'INVITED' }));

  console.log('\nDone. Nothing was created or modified.\n');
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Diagnostic failed:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
