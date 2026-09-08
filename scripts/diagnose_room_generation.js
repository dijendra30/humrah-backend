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
  // WHY a pair failed, not just that it did. Ineligibility is a HARD gate
  // (checkEligibility) and is invisible in the score distribution — a pair
  // rejected for no_shared_language reports score 0 and looks like a bad match.
  const ineligibleReasons = {};
  // Per-signal breakdown. A component scoring 0 keeps its weight and drags the
  // weighted average down; a component that is null is skipped entirely and costs
  // nothing. Separating the two is what identifies the real blocker.
  const comp = {};
  const noteComponent = (name, value) => {
    comp[name] = comp[name] || { zero: 0, partial: 0, full: 0, missing: 0 };
    if (value === null || value === undefined) comp[name].missing++;
    else if (value === 0) comp[name].zero++;
    else if (value >= 1) comp[name].full++;
    else comp[name].partial++;
  };

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      pairs++;
      let p;
      try { p = matching.calculatePairwiseCompatibility(pool[i], pool[j]); } catch (_) { continue; }
      if (p.eligible) {
        eligiblePairs++;
        Object.entries(p.components || {}).forEach(([k, v]) => noteComponent(k, v));
      } else {
        const r = p.reason || 'unknown';
        ineligibleReasons[r] = (ineligibleReasons[r] || 0) + 1;
      }
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
  line('pairs REJECTED as ineligible (hard gate)', pairs - eligiblePairs);
  Object.entries(ineligibleReasons).sort((a, b) => b[1] - a[1])
    .forEach(([r, c]) => line(`    reason: ${r}`, c));
  line(`pairs scoring >= ${CONFIG.MIN_PAIRWISE_SCORE}  <-- groups need these`, passingPairs);
  line('best score seen', best);
  console.log('  score distribution:');
  Object.entries(buckets).forEach(([k, v]) => line(`    ${k}`, v));

  console.log('  per-signal breakdown across eligible pairs');
  console.log('    (zero = both had data but NOTHING in common -> keeps its weight, drags score down)');
  console.log('    (missing = one side had no data -> signal skipped, costs nothing)');
  const WEIGHTS = matching.WEIGHTS || {};
  Object.entries(comp)
    .sort((a, b) => (WEIGHTS[b[0]] || 0) - (WEIGHTS[a[0]] || 0))
    .forEach(([name, c]) => {
      const w = WEIGHTS[name] !== undefined ? `${Math.round(WEIGHTS[name] * 100)}%` : '?';
      line(`    ${name} (weight ${w})`, `zero=${c.zero}  partial=${c.partial}  full=${c.full}  missing=${c.missing}`);
    });

  if (passingPairs === 0) {
    console.log(`\n  >>> DEAD END: no two candidates are compatible enough to seed a Room.`);
    console.log(`      Best pair scored ${best} against a required ${CONFIG.MIN_PAIRWISE_SCORE}.`);
    if ((pairs - eligiblePairs) === pairs && pairs > 0) {
      console.log('      EVERY pair failed the HARD eligibility gate — scores are irrelevant.');
      console.log('      See the reason counts above (usually no_shared_language).');
    } else {
      const worst = Object.entries(comp)
        .filter(([n]) => (WEIGHTS[n] || 0) >= 0.2)
        .sort((a, b) => b[1].zero - a[1].zero)[0];
      if (worst && worst[1].zero > 0) {
        console.log(`      Biggest drag: "${worst[0]}" scored ZERO on ${worst[1].zero} eligible pairs`);
        console.log(`      at weight ${Math.round((WEIGHTS[worst[0]] || 0) * 100)}%.`);
        console.log('      NOTE: topic(35%) + conversation(20%) both zero caps a pair at 45 —');
        console.log('      mathematically below the required 60, however good everything else is.');
      }
    }
    console.log('');
  }

  // ── Stage 3.5: the group gates the pairwise score does NOT cover ───────────
  console.log('\nSTAGE 3.5 — group viability (the gate after pairwise)');
  const gen = require('../services/systemRoomGeneratorService');

  // THE DIRECT ANSWER TO "will Rooms be created?". Runs the REAL production
  // evaluateGroupViability() over every candidate pair, so it accounts for the
  // pairwise gate, the cohesion gate, evidence confidence AND the shared-topic
  // requirement together — which no single earlier stage does.
  let pairGroupsViable = 0;
  const pairReasons = {};
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      let v;
      try { v = gen.evaluateGroupViability([pool[i], pool[j]]); } catch (_) { continue; }
      if (v.viable) pairGroupsViable++;
      else {
        // Collapse the numeric suffix so "min_pairwise_too_low (54)" and "(28)"
        // aggregate into one bucket.
        const key = String(v.reason || 'unknown').replace(/\s*\(.*\)$/, '');
        pairReasons[key] = (pairReasons[key] || 0) + 1;
      }
    }
  }
  line('2-person groups that WOULD be created', pairGroupsViable);
  Object.entries(pairReasons).sort((a, b) => b[1] - a[1])
    .forEach(([r, c]) => line(`    blocked by: ${r}`, c));
  if (pairGroupsViable > 0) {
    console.log(`\n  >>> ${pairGroupsViable} Room(s) can be created on the next generator run.\n`);
  }

  // Topic overlap: selectRoomTopic() needs >= 2 users wanting the SAME topic.
  const topicCounts = {};
  pool.forEach(u => (u.questionnaire?.humrahRoomInterests || []).forEach(t => {
    topicCounts[t] = (topicCounts[t] || 0) + 1;
  }));
  const sharedTopics = Object.entries(topicCounts).filter(([, n]) => n >= 2);
  line('distinct topics chosen across candidates', Object.keys(topicCounts).length);
  Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).forEach(([t, n]) =>
    line(`    "${t}"`, `${n} user(s)`));
  line('topics wanted by >= 2 users  <-- REQUIRED', sharedTopics.length);
  if (sharedTopics.length === 0) {
    console.log('\n  >>> DEAD END: selectRoomTopic() requires at least TWO candidates to have');
    console.log('      chosen the SAME topic. No topic is shared, so no group can be formed.');
    console.log('      This is why nothing is created and nothing is logged as rejected.\n');
  }

  // Run the real group builder and report the real reason.
  const groups = gen.buildCandidateGroups(pool);
  line('viable groups built by the real builder', groups.length);

  if (groups.length === 0 && pool.length >= gen.CONFIG.MIN_GROUP_SIZE) {
    const cohesion = gen.calculateGroupCohesion(pool.slice(0, gen.CONFIG.MAX_GROUP_SIZE));
    line('  cohesion.valid', cohesion.valid);
    line('  cohesion.cohesionScore', cohesion.cohesionScore);
    line('  cohesion.minPairwiseScore', cohesion.minPairwiseScore);
    line('  cohesion.avgConfidence (needs >= 2)', cohesion.avgConfidence !== undefined ? cohesion.avgConfidence.toFixed(2) : 'n/a');
    const verdict = gen.evaluateGroupViability(pool.slice(0, gen.CONFIG.MAX_GROUP_SIZE));
    line('  evaluateGroupViability.viable', verdict.viable);
    line('  >>> EXACT REJECTION REASON', verdict.reason || '(none)');
    const topic = gen.selectRoomTopic(pool.slice(0, gen.CONFIG.MAX_GROUP_SIZE));
    line('  selectRoomTopic()', topic ? `"${topic.topic}" (support ${topic.supportCount})` : 'null — no shared valid topic');
  } else if (groups.length > 0) {
    groups.forEach(g => line('  group', `${g.users.length} members, topic "${g.evaluation.selectedTopic}", score ${g.evaluation.groupScore}`));
    console.log('\n  >>> Groups ARE viable. If no Room exists, the blocker is in createSystemRoom()');
    console.log('      (duplicate-room check or a write failure) — check [RoomGenerator] logs.\n');
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
