// services/engagement/sources/humrahRooms.js
// ROOMS — an active, public (ALL_INDIA) Humrah Room whose topic the user picked as an
// interest, with a recent conversation and space to join.
//
// Never: PRIVATE Rooms, NEAR_ME Rooms (their visibility depends on proximity rules this
// phase does not re-implement), SUGGESTED/FULL/INACTIVE/CLOSED or standby Rooms, Rooms
// the user has any membership record in (joined, left, invited or kicked), or Rooms
// where the creator or a member is blocked either way. The copy names only the
// canonical TOPIC (from utils/roomTopicConfig), never a user-written Room title or a
// member.
'use strict';

const mongoose = require('mongoose');
const HumrahRoom = require('../../../models/HumrahRoom');
const RoomMember = require('../../../models/RoomMember');
const User = require('../../../models/User');
const { canonicalizeTopic } = require('../../../utils/roomTopicConfig');

const HOUR = 3600 * 1000;

function roomUsable(room, now, cfg) {
  if (!room) return 'DELETED';
  if (room.status !== 'ACTIVE' || room.standby === true) return 'NOT_ACTIVE';
  if (room.discoveryMode !== 'ALL_INDIA') return 'NOT_PUBLIC';
  if (Number(room.memberCount || 0) < 2) return 'TOO_QUIET';
  if (Number(room.memberCount || 0) >= Number(room.capacity || 0)) return 'FULL';
  const last = room.lastMessageAt ? new Date(room.lastMessageAt).getTime() : NaN;
  if (!Number.isFinite(last) || now - last > cfg.roomActiveWithinMs) return 'NO_RECENT_CONVERSATION';
  if (!canonicalizeTopic(room.topic)) return 'UNKNOWN_TOPIC';
  return null;
}

const ROOM_FIELDS = 'topic status standby discoveryMode memberCount capacity lastMessageAt createdBy';

// The candidate Rooms and their joined members are the same for every user in a tick.
async function loadShared(ctx) {
  if (ctx.shared.rooms) return ctx.shared.rooms;
  const { now, cfg } = ctx;
  const rooms = await HumrahRoom.find({
    status: 'ACTIVE', discoveryMode: 'ALL_INDIA', standby: { $ne: true },
    memberCount: { $gte: 2 }, lastMessageAt: { $gte: new Date(now - cfg.roomActiveWithinMs) },
  }).select(ROOM_FIELDS).sort({ lastMessageAt: -1 }).limit(200).lean();
  const usable = rooms.filter(r => !roomUsable(r, now, cfg));
  const members = usable.length
    ? await RoomMember.find({ roomId: { $in: usable.map(r => r._id) }, status: 'JOINED' }).select('roomId userId').lean()
    : [];
  const membersByRoom = new Map();
  for (const m of members) {
    const k = String(m.roomId);
    if (!membersByRoom.has(k)) membersByRoom.set(k, []);
    membersByRoom.get(k).push(String(m.userId));
  }
  ctx.shared.rooms = { list: usable, membersByRoom };
  return ctx.shared.rooms;
}

async function collect(ctx) {
  if (!ctx.roomTopics.length) return [];
  const { list, membersByRoom } = await loadShared(ctx);
  const topicSet = new Set(ctx.roomTopics);
  const matching = list.filter(r => topicSet.has(canonicalizeTopic(r.topic)));
  if (matching.length === 0) return [];

  const mine = await RoomMember.find({ userId: ctx.userId, roomId: { $in: matching.map(r => r._id) } }).select('roomId').lean();
  const mineSet = new Set(mine.map(m => String(m.roomId)));

  const out = [];
  for (const room of matching) {
    if (mineSet.has(String(room._id))) continue;
    if (room.createdBy && (String(room.createdBy) === String(ctx.userId) || ctx.blocked.set.has(String(room.createdBy)))) continue;
    if ((membersByRoom.get(String(room._id)) || []).some(id => ctx.blocked.set.has(id))) continue;
    const ageH = (ctx.now - new Date(room.lastMessageAt).getTime()) / HOUR;
    out.push({
      category: 'ROOMS',
      eventType: 'HUMRAH_ROOM',
      eventRef: { kind: 'HumrahRoom', id: String(room._id) },
      eventKey: `HUMRAH_ROOM:${room._id}`,
      purpose: 'active_room',
      vars: { topic_label: canonicalizeTopic(room.topic) },
      relevance: Math.max(0.6, 1 - ageH / (ctx.cfg.roomActiveWithinMs / HOUR) * 0.4),
      relevantUntil: new Date(ctx.now + 24 * HOUR),
    });
  }
  // How many matching public Rooms this user could join (only shown when >= 2).
  for (const o of out) o.vars.public_room_count = out.length;
  return out;
}

async function revalidate(doc, user, now, cfg) {
  if (!mongoose.isValidObjectId(doc.eventRef.id)) return { ok: false, reason: 'EVENT_INVALID' };
  const room = await HumrahRoom.findById(doc.eventRef.id).select(ROOM_FIELDS).lean();
  const why = roomUsable(room, now, cfg);
  if (why) return { ok: false, reason: `EVENT_${why}` };
  if (await RoomMember.exists({ roomId: room._id, userId: user._id })) return { ok: false, reason: 'EVENT_ALREADY_MEMBER' };
  if (room.createdBy) {
    const createdBy = String(room.createdBy);
    if ((user.blockedUsers || []).map(String).includes(createdBy)) return { ok: false, reason: 'EVENT_BLOCKED' };
    if (await User.exists({ _id: room.createdBy, blockedUsers: user._id })) return { ok: false, reason: 'EVENT_BLOCKED' };
  }
  return { ok: true };
}

module.exports = { category: 'ROOMS', eventType: 'HUMRAH_ROOM', collect, revalidate, _internal: { roomUsable } };
