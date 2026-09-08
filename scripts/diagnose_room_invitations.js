// scripts/diagnose_room_invitations.js
// -----------------------------------------------------------------------------
// READ-ONLY. Answers "why did nobody join the Rooms the generator created?"
//
// Replays every gate in roomInvitationService.processRoomInvitations() against
// live data WITHOUT sending anything, writing anything, or burning any dedup or
// cooldown key. Nothing here mutates state.
//
// Run: node scripts/diagnose_room_invitations.js
// -----------------------------------------------------------------------------
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const redisService = require('../services/redisService');

// Same key builders the worker uses. Read only — never set.
const dedupKeyFor = (roomId, userId) => `room_invitation_sent:${roomId}:${userId}`;
const cooldownKeyFor = (userId) => `cooldown:room_invite:user:${userId}`;
const COOLDOWN_HOURS = parseInt(process.env.ROOM_INVITATION_COOLDOWN_HOURS || '12', 10);

const line = (label, value) => console.log(`  ${String(label).padEnd(46)} ${value}`);
const isBlockedPair = (a, b) => {
  if (!a || !b) return false;
  return (a.blockedUsers || []).some(id => String(id) === String(b._id))
    || (b.blockedUsers || []).some(id => String(id) === String(a._id));
};

(async () => {
  // Same env var the generator diagnostic uses; MONGO_URI accepted as a fallback.
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected.\n');

  const now = Date.now();

  // ── Deployed configuration ────────────────────────────────────────────────
  // Printed FIRST so one run tells you whether the fixes are actually live on
  // this container, instead of inferring it from downstream symptoms.
  let lifetimeHours = 2;
  let requireReachable = false;
  let configLoaded = false;
  try {
    const lc = require('../services/roomLifecycleConfig');
    lifetimeHours = lc.ROOM_LIFECYCLE_CONFIG.SUGGESTED_LIFETIME_HOURS;
    configLoaded = true;
  } catch (_) { /* old build: roomLifecycleConfig does not exist yet */ }
  try {
    requireReachable = require('../services/roomCandidateService')
      .CANDIDATE_CONFIG.REQUIRE_REACHABLE === true;
  } catch (_) { /* old build */ }

  console.log('DEPLOYED CONFIG');
  line('SUGGESTED Room lifetime', configLoaded
    ? `${lifetimeHours}h  (shared config LIVE)`
    : '2h  <-- OLD BUILD: roomLifecycleConfig not deployed');
  line('seed Rooms only with reachable users', requireReachable
    ? 'ON  (reachability gate LIVE)'
    : 'OFF <-- OLD BUILD: candidate gate not deployed');
  if (!configLoaded || !requireReachable) {
    console.log('  >>> The fixes are NOT fully deployed. Everything below reflects');
    console.log('      the OLD behaviour, so judge the fixes only after deploying.');
  }
  console.log('');

  const windowMs = lifetimeHours * 60 * 60 * 1000;
  const windowStart = new Date(now - windowMs);

  // ── Stage 0: what the worker would actually scan ──────────────────────────
  console.log('STAGE 0 — Rooms the invitation worker can see');
  const inWindow = await HumrahRoom.find({
    creationSource: 'SYSTEM', status: 'SUGGESTED', createdAt: { $gte: windowStart },
  }).lean();
  const allSuggested = await HumrahRoom.find({
    creationSource: 'SYSTEM', status: 'SUGGESTED',
  }).lean();

  line('SYSTEM+SUGGESTED Rooms total', allSuggested.length);
  line(`...inside the ${lifetimeHours}h invitation window  <-- SCANNED`, inWindow.length);
  line('...aged OUT of the window (never invitable again)', allSuggested.length - inWindow.length);

  allSuggested.forEach(r => {
    const ageMin = Math.round((now - new Date(r.createdAt).getTime()) / 60000);
    line(`    ${String(r._id)}`, `"${r.topic}"  age ${ageMin} min  ${ageMin > lifetimeHours * 60 ? 'EXPIRED FROM WINDOW' : 'in window'}`);
  });

  // WHAT HAPPENED TO THE ROOMS THAT ARE NO LONGER SUGGESTED.
  // A Room leaving SUGGESTED means one of two OPPOSITE things:
  //   -> ACTIVE  : people joined. The pipeline worked end to end.
  //   -> CLOSED  : the expiry job closed it. Nobody joined inside the lifetime.
  // Without this, an empty SUGGESTED list looks identical in both cases.
  console.log('\n  outcome of every SYSTEM Room');
  const systemRooms = await HumrahRoom.find({ creationSource: 'SYSTEM' })
    .sort({ createdAt: -1 }).limit(20).lean();
  const byStatus = {};
  systemRooms.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  Object.entries(byStatus).forEach(([s, c]) => line(`    ${s}`, c));

  const recent = systemRooms.slice(0, 6);
  if (recent.length > 0) {
    console.log('  most recent SYSTEM Rooms');
    for (const r of recent) {
      const ageMin = Math.round((now - new Date(r.createdAt).getTime()) / 60000);
      const joined = await RoomMember.countDocuments({ roomId: r._id, status: 'JOINED' });
      const invited = await RoomMember.countDocuments({ roomId: r._id, status: 'INVITED' });
      const verdict = r.status === 'ACTIVE' || r.status === 'FULL'
        ? 'JOINED — pipeline worked'
        : (r.status === 'CLOSED' ? `EXPIRED — nobody joined in ${lifetimeHours}h` : '');
      line(`    ${String(r._id)}`,
        `${String(r.status).padEnd(9)} "${r.topic}"  age ${ageMin}m  joined=${joined} invited=${invited}  ${verdict}`);
    }
  }

  if (allSuggested.length === 0) {
    console.log('\n  >>> No SUGGESTED Rooms right now. Read the outcome list above:');
    console.log('      ACTIVE/FULL = people joined. CLOSED = expired unjoined.\n');
  }

  // ── Stage 1: per-Room, per-member gate replay ─────────────────────────────
  console.log('\nSTAGE 1 — per-member gate replay (read-only)');
  const reasons = {};
  const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
  let totalInvited = 0, wouldSend = 0;

  const target = allSuggested.length > 0 ? allSuggested : [];
  for (const room of target) {
    const roomId = String(room._id);
    const ageMin = Math.round((now - new Date(room.createdAt).getTime()) / 60000);
    console.log(`\n  Room ${roomId}  "${room.topic}"  (age ${ageMin} min)`);

    const allMembers = await RoomMember.find({
      roomId: room._id, status: { $in: ['INVITED', 'JOINED'] },
    }).select('userId status').lean();
    const invited = allMembers.filter(m => m.status === 'INVITED');
    const joined = allMembers.filter(m => m.status === 'JOINED');
    line('    INVITED members', invited.length);
    line('    JOINED members', joined.length);
    totalInvited += invited.length;

    if (ageMin > lifetimeHours * 60) {
      line('    worker verdict', `NOT SCANNED — outside the ${lifetimeHours}h window`);
      invited.forEach(() => bump('room_outside_window'));
      continue;
    }

    const users = await User.find({ _id: { $in: allMembers.map(m => m.userId) } })
      .select('_id status suspensionInfo pushNotifications fcmDevices blockedUsers').lean();
    const userById = new Map(users.map(u => [String(u._id), u]));
    const counterparts = allMembers.map(m => userById.get(String(m.userId))).filter(Boolean);

    for (const member of invited) {
      const userId = String(member.userId);
      const u = userById.get(userId);
      let verdict = null;

      if (await redisService.get(dedupKeyFor(roomId, userId))) verdict = 'already_notified_dedup';
      else if (await redisService.get(cooldownKeyFor(userId))) verdict = `user_cooldown_${COOLDOWN_HOURS}h`;
      else if (!u) verdict = 'user_missing';
      else if (u.status !== 'ACTIVE') verdict = 'user_not_active';
      else if (u.suspensionInfo?.isSuspended === true) verdict = 'user_suspended';
      else if (u.pushNotifications === false) verdict = 'push_disabled';
      else if (counterparts.some(o => String(o._id) !== userId && isBlockedPair(u, o))) verdict = 'blocked_pair';
      else {
        const devices = u.fcmDevices || [];
        const capable = devices.filter(d => d.supportsHumrahRooms === true && typeof d.token === 'string' && d.token.trim());
        if (devices.length === 0) verdict = 'no_device_registered';
        else if (capable.length === 0) verdict = 'no_capable_device';
      }

      if (verdict) { bump(verdict); line(`    ${userId}`, `BLOCKED: ${verdict}`); }
      else { wouldSend++; bump('would_send'); line(`    ${userId}`, 'would receive an invitation'); }
    }
  }

  // ── Stage 2: device capability across the whole base ──────────────────────
  console.log('\nSTAGE 2 — device capability across ALL active users');
  const actives = await User.find({ status: 'ACTIVE' }).select('_id fcmDevices pushNotifications').lean();
  let noDevice = 0, hasDevice = 0, capable = 0, pushOff = 0;
  actives.forEach(u => {
    if (u.pushNotifications === false) pushOff++;
    const d = u.fcmDevices || [];
    if (d.length === 0) { noDevice++; return; }
    hasDevice++;
    if (d.some(x => x.supportsHumrahRooms === true && typeof x.token === 'string' && x.token.trim())) capable++;
  });
  line('active users', actives.length);
  line('...with NO fcm device at all', noDevice);
  line('...with a device registered', hasDevice);
  line('...with a ROOM-CAPABLE device  <-- REQUIRED', capable);
  line('...who disabled push entirely', pushOff);

  // THE NUMBER THAT DECIDES EVERYTHING. The generator draws candidates from users
  // who answered Q24, but a Room is only useful if those users can actually be told
  // about it inside the 2h SUGGESTED window. The ADDRESSABLE population is the
  // intersection, and roomCandidateService does not currently consider it at all.
  const q24 = await User.find({
    status: 'ACTIVE',
    'questionnaire.humrahRoomInterests.0': { $exists: true },
  }).select('_id fcmDevices').lean();
  const q24Capable = q24.filter(u => (u.fcmDevices || [])
    .some(d => d.supportsHumrahRooms === true && typeof d.token === 'string' && d.token.trim()));
  console.log('  ADDRESSABLE POPULATION (what the generator can usefully seed)');
  line('    answered Q24', q24.length);
  line('    ...AND have a room-capable device  <-- REAL POOL', q24Capable.length);
  if (q24.length > 0) {
    line('    reachable share of Q24 users',
      `${Math.round((q24Capable.length / q24.length) * 100)}%`);
  }
  if (q24Capable.length < 2) {
    console.log('    >>> Below 2, no Room can be seeded with two reachable people.');
  }

  if (hasDevice > 0 && capable === 0) {
    console.log('\n  >>> DEAD END: not a single device is flagged supportsHumrahRooms.');
    console.log('      No Room invitation can EVER be delivered. The flag is set when');
    console.log('      the app registers its FCM token; devices registered by an older');
    console.log('      build default to false and are never targeted.');
    console.log('      FIX: users must reopen the current app build so the token');
    console.log('      re-registers with the capability flag.\n');
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log('\nVERDICT');
  line('INVITED memberships examined', totalInvited);
  line('would receive an invitation right now', wouldSend);
  Object.entries(reasons).sort((a, b) => b[1] - a[1])
    .forEach(([r, c]) => line(`    ${r}`, c));

  if (totalInvited > 0 && wouldSend === 0) {
    console.log('\n  >>> Nobody can be notified. The reason counts above say why.');
    console.log('      Rooms were created correctly — delivery is the blocker, not generation.\n');
  }

  await mongoose.disconnect();
  console.log('\nDone. Nothing was created, sent or modified.');
  process.exit(0);
})().catch(e => { console.error('DIAGNOSTIC ERROR:', e.message); process.exit(1); });
