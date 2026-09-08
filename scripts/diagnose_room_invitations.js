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
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);

  // ── Stage 0: what the worker would actually scan ──────────────────────────
  console.log('STAGE 0 — Rooms the invitation worker can see');
  const inWindow = await HumrahRoom.find({
    creationSource: 'SYSTEM', status: 'SUGGESTED', createdAt: { $gte: twoHoursAgo },
  }).lean();
  const allSuggested = await HumrahRoom.find({
    creationSource: 'SYSTEM', status: 'SUGGESTED',
  }).lean();

  line('SYSTEM+SUGGESTED Rooms total', allSuggested.length);
  line('...inside the 2h invitation window  <-- SCANNED', inWindow.length);
  line('...aged OUT of the window (never invitable again)', allSuggested.length - inWindow.length);

  allSuggested.forEach(r => {
    const ageMin = Math.round((now - new Date(r.createdAt).getTime()) / 60000);
    line(`    ${String(r._id)}`, `"${r.topic}"  age ${ageMin} min  ${ageMin > 120 ? 'EXPIRED FROM WINDOW' : 'in window'}`);
  });

  if (allSuggested.length === 0) {
    console.log('\n  >>> No SUGGESTED Rooms exist. Either none were generated, or the');
    console.log('      2h expiry job already closed them. Check STAGE 4 of the');
    console.log('      generator diagnostic for SYSTEM/CLOSED counts.\n');
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

    if (ageMin > 120) {
      line('    worker verdict', 'NOT SCANNED — outside the 2h window');
      invited.forEach(() => bump('room_outside_2h_window'));
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
