// services/roomSupplyService.js
// -----------------------------------------------------------------------------
// Room supply (6 Nov 2026, approved by the product owner).
//
// Humrah-hosted Rooms fill the gap when people haven't made enough Rooms of their own:
//
//   open public user Rooms   0   1   2   3   4+
//   Humrah-hosted Rooms      5   4   3   2   0
//
// (5 minus user Rooms, and none at all once there are 4.)
//
// Rules:
//   - A Humrah-hosted Room that anyone has joined is NEVER put away. It stays visible
//     even when that takes the total above the target.
//   - Rooms are only put away ("standby") or brought back. Nothing is deleted, no
//     message is touched, no membership is created. A standby Room keeps its history.
//   - Which topics: the 35 global topics, chosen by how many recently active people
//     picked them as a Room interest. A topic a user Room already covers is skipped.
//     Rooms already showing get a small head start, so the set doesn't churn.
//   - A topic that has never had a Humrah-hosted Room gets one, with the approved copy
//     from utils/curatedRoomConfig.js (insert-only, idempotent on curatedTopicKey).
//
// Gated by ROOM_SUPPLY_ENABLED (default false): with the flag off this never runs and
// every seeded Room stays as it is today.
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const { ALL_TOPIC_ROOMS, topicRoomEntry, CREATION_SOURCE_CURATED } = require('../utils/curatedRoomConfig');
const { canonicalizeTopic } = require('../utils/roomTopicConfig');
const { curatedRoomDocument } = require('../scripts/rooms/seed-curated-rooms');

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

const SUPPLY_CONFIG = {
  // Humrah-hosted Rooms when there are no user Rooms; one fewer per user Room.
  MAX_HUMRAH_ROOMS: num(process.env.ROOM_SUPPLY_MAX_HUMRAH_ROOMS, 5),
  // From this many open user Rooms on, no empty Humrah-hosted Room is shown.
  USER_ROOMS_FOR_NONE: num(process.env.ROOM_SUPPLY_USER_ROOMS_FOR_NONE, 4),
  // Interest counts come from people active in this window.
  INTEREST_ACTIVE_DAYS: num(process.env.ROOM_SUPPLY_INTEREST_ACTIVE_DAYS, 30),
  // A Room already showing keeps its place unless another topic beats it by this much.
  STICKY_MIN_BONUS: 2,
  STICKY_FRACTION: 0.2,
};

const PUBLIC_MODES = ['NEAR_ME', 'ALL_INDIA'];
const TOPIC_ORDER = new Map(ALL_TOPIC_ROOMS.map((e, i) => [e.topic, i]));

/**
 * Pure decision. No I/O.
 *
 * @param {object}   s
 * @param {number}   s.userRoomCount   open public user Rooms
 * @param {string[]} s.userRoomTopics  their topics (canonical)
 * @param {Array<{id:string, topic:string, status:string, standby:boolean, joined:number}>} s.curated
 * @param {Map<string,number>} s.popularity  canonical topic -> people interested
 * @returns {{target:number, occupied:number, show:string[], hide:string[], create:string[], visibleAfter:number}}
 *          show/hide are Room ids; create is canonical topics with no Humrah-hosted Room yet.
 */
function planSupply({ userRoomCount, userRoomTopics = [], curated = [], popularity = new Map(),
  maxHumrahRooms = SUPPLY_CONFIG.MAX_HUMRAH_ROOMS, userRoomsForNone = SUPPLY_CONFIG.USER_ROOMS_FOR_NONE }) {
  const users = Math.max(0, userRoomCount | 0);
  const target = users >= userRoomsForNone ? 0 : Math.max(0, maxHumrahRooms - users);
  const show = [];
  const hide = [];
  const create = [];

  // Only ACTIVE curated Rooms take part. FULL ones are not discoverable anyway, and a
  // curated Room is never INACTIVE/CLOSED (the expiry job skips them).
  const active = curated.filter(r => r.status === 'ACTIVE');

  // 1. Joined Rooms are always visible.
  const occupied = active.filter(r => r.joined > 0);
  occupied.filter(r => r.standby).forEach(r => show.push(r.id));
  const takenTopics = new Set(occupied.map(r => r.topic));

  // 2. The empty slots left.
  const slots = Math.max(0, target - occupied.length);

  // 3. Candidates: every empty curated Room, plus every topic that has no curated Room
  //    yet. Topics a user Room or a joined Humrah Room already covers are left out.
  const coveredByUsers = new Set(userRoomTopics);
  const roomByTopic = new Map();
  active.filter(r => r.joined === 0).forEach(r => { if (!roomByTopic.has(r.topic)) roomByTopic.set(r.topic, r); });
  const allTopics = new Set(curated.map(r => r.topic));

  const candidates = [];
  for (const entry of ALL_TOPIC_ROOMS) {
    const topic = entry.topic;
    if (takenTopics.has(topic)) continue;
    const room = roomByTopic.get(topic) || null;
    // A topic whose only curated Room is not ACTIVE (should not happen) is left alone.
    if (!room && allTopics.has(topic)) continue;
    const visible = Boolean(room && !room.standby);
    const base = popularity.get(topic) || 0;
    const bonus = visible ? Math.max(SUPPLY_CONFIG.STICKY_MIN_BONUS, Math.ceil(base * SUPPLY_CONFIG.STICKY_FRACTION)) : 0;
    candidates.push({ topic, room, visible, coveredByUser: coveredByUsers.has(topic), score: base + bonus });
  }

  const ranked = candidates
    .filter(c => !c.coveredByUser)
    .sort((a, b) => (b.score - a.score) || (TOPIC_ORDER.get(a.topic) - TOPIC_ORDER.get(b.topic)));
  const desired = new Set(ranked.slice(0, slots).map(c => c.topic));

  for (const c of candidates) {
    const want = desired.has(c.topic);
    if (want && !c.room) create.push(c.topic);
    else if (want && c.room.standby) show.push(c.room.id);
    else if (!want && c.visible) hide.push(c.room.id);
  }

  return { target, occupied: occupied.length, show, hide, create, visibleAfter: occupied.length + desired.size };
}

/** canonical topic -> number of recently active people with it as a Room interest. */
async function loadInterestPopularity(now = new Date()) {
  const since = new Date(now.getTime() - SUPPLY_CONFIG.INTEREST_ACTIVE_DAYS * 86400000);
  const rows = await User.aggregate([
    { $match: { status: 'ACTIVE', lastActive: { $gte: since }, 'questionnaire.humrahRoomInterests.0': { $exists: true } } },
    { $project: { i: '$questionnaire.humrahRoomInterests' } },
    { $unwind: '$i' },
    { $group: { _id: { u: '$_id', t: { $toLower: { $trim: { input: '$i' } } } } } },
    { $group: { _id: '$_id.t', n: { $sum: 1 } } },
  ]);
  const popularity = new Map();
  for (const r of rows) {
    const topic = canonicalizeTopic(r._id);
    if (topic && topicRoomEntry(topic)) popularity.set(topic, (popularity.get(topic) || 0) + r.n);
  }
  return popularity;
}

/** Current state, read in four bounded queries. */
async function loadSupplyState(now = new Date()) {
  const [userRooms, curatedRooms] = await Promise.all([
    HumrahRoom.find({ creationSource: 'USER', status: 'ACTIVE', discoveryMode: { $in: PUBLIC_MODES } })
      .select('topic').limit(500).lean(),
    HumrahRoom.find({ creationSource: CREATION_SOURCE_CURATED })
      .select('topic status standby memberCount curatedTopicKey').limit(200).lean(),
  ]);
  const joinedRows = curatedRooms.length === 0 ? [] : await RoomMember.aggregate([
    { $match: { roomId: { $in: curatedRooms.map(r => r._id) }, status: 'JOINED' } },
    { $group: { _id: '$roomId', n: { $sum: 1 } } },
  ]);
  const joinedById = new Map(joinedRows.map(r => [String(r._id), r.n]));
  const popularity = await loadInterestPopularity(now);
  return {
    userRoomCount: userRooms.length,
    userRoomTopics: [...new Set(userRooms.map(r => canonicalizeTopic(r.topic)).filter(Boolean))],
    curated: curatedRooms.map(r => ({
      id: String(r._id),
      topic: canonicalizeTopic(r.topic) || r.topic,
      status: r.status,
      standby: r.standby === true,
      joined: joinedById.get(String(r._id)) || 0,
    })),
    popularity,
  };
}

/**
 * One supply pass. Never throws. Writes only:
 *   - $set standby:true   on an EMPTY curated Room (conditional on memberCount 0),
 *   - $unset standby      on a curated Room,
 *   - insert-only upsert of a new curated Room for a chosen topic.
 */
async function runRoomSupply({ now = new Date(), dryRun = false } = {}) {
  const summary = {
    event: 'room_supply', dryRun, target: 0, userRooms: 0, occupied: 0,
    shown: 0, hidden: 0, created: 0, hideReverted: 0, failed: false,
  };
  try {
    const state = await loadSupplyState(now);
    const plan = planSupply(state);
    Object.assign(summary, { target: plan.target, userRooms: state.userRoomCount, occupied: plan.occupied, plan: dryRun ? plan : undefined });
    if (dryRun) return summary;

    for (const id of plan.show) {
      const r = await HumrahRoom.updateOne({ _id: id, creationSource: CREATION_SOURCE_CURATED, standby: true }, { $unset: { standby: 1 } });
      summary.shown += r.modifiedCount;
    }
    for (const id of plan.hide) {
      const r = await HumrahRoom.updateOne(
        { _id: id, creationSource: CREATION_SOURCE_CURATED, memberCount: 0, standby: { $ne: true } },
        { $set: { standby: true } }
      );
      if (r.modifiedCount === 0) continue;
      // Someone may have joined between the read and the write: put it straight back.
      if (await RoomMember.exists({ roomId: id, status: 'JOINED' })) {
        await HumrahRoom.updateOne({ _id: id }, { $unset: { standby: 1 } });
        summary.hideReverted++;
        continue;
      }
      summary.hidden++;
    }
    for (const topic of plan.create) {
      const entry = topicRoomEntry(topic);
      if (!entry) continue;
      const doc = curatedRoomDocument(entry, now);
      await new HumrahRoom(doc).validate();
      const r = await HumrahRoom.collection.updateOne({ curatedTopicKey: entry.key }, { $setOnInsert: doc }, { upsert: true });
      summary.created += r.upsertedCount;
    }
  } catch (err) {
    summary.failed = true;
    summary.error = err.message;
  }
  // Counts only: no user data.
  if (summary.shown || summary.hidden || summary.created || summary.failed) {
    console.log('[RoomSupply]', JSON.stringify({ ...summary, plan: undefined }));
  }
  return summary;
}

module.exports = { SUPPLY_CONFIG, planSupply, loadSupplyState, loadInterestPopularity, runRoomSupply };
