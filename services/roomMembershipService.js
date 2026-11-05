// services/roomMembershipService.js
// -----------------------------------------------------------------------------
// Rooms Phase 2.3 — shared membership upkeep:
//
//   recountRoomMembers(roomId)         authoritative JOINED count -> HumrahRoom.memberCount
//                                      (and FULL -> ACTIVE when a seat frees up), under the
//                                      same Redis lock joinRoom / leaveRoom use.
//   releaseUserMemberships(userId, io) account deletion: the user's JOINED / INVITED
//                                      memberships become LEFT and every affected Room is
//                                      recounted. Idempotent — a second run finds nothing.
//   emitMembershipChanged(io, room, change)
//                                      the real-membership socket event (see below).
//
// WHY A NEW EVENT: the existing room_member_joined / room_member_left are emitted when a
// member OPENS or CLOSES the Room screen (socket join_room / leave_room / disconnect).
// They mean presence, and their meaning is kept. Actual joins and leaves (REST) had no
// event at all, so an open Room never saw its member count change.
// 'room_membership_changed' is additive: old clients ignore it.
// Payload: { roomId, change: 'JOINED' | 'LEFT', memberCount, capacity, status } —
// aggregate counts only, no user identity.
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const redisService = require('./redisService');

const MEMBERSHIP_EVENT = 'room_membership_changed';
const roomLockKey = (roomId) => `lock:room_join:${roomId}`; // the key joinRoom / leaveRoom use
const LOCK_ATTEMPTS = 20;
const LOCK_RETRY_MS = 100;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Runs fn under the room lock; waits briefly for it, then runs anyway (recount is idempotent). */
async function withRoomLock(roomId, fn) {
  let locked = false;
  for (let i = 0; i < LOCK_ATTEMPTS && !locked; i++) {
    locked = await redisService.acquireLock(roomLockKey(roomId), 10).catch(() => false);
    if (!locked) await sleep(LOCK_RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    if (locked) await redisService.releaseLock(roomLockKey(roomId)).catch(() => {});
  }
}

/**
 * Sets memberCount to the number of JOINED RoomMember records. A FULL Room that now has
 * a free seat reopens (the same rule leaveRoom applies). Returns the updated lean Room,
 * or null when the Room no longer exists. The caller must NOT hold the room lock.
 */
async function recountRoomMembers(roomId) {
  return withRoomLock(roomId, async () => {
    const count = await RoomMember.countDocuments({ roomId, status: 'JOINED' });
    const room = await HumrahRoom.findById(roomId).select('status capacity memberCount').lean();
    if (!room) return null;
    const set = { memberCount: count };
    if (room.status === 'FULL' && count < room.capacity) set.status = 'ACTIVE';
    return HumrahRoom.findByIdAndUpdate(roomId, { $set: set }, { new: true })
      .select('_id status capacity memberCount').lean();
  });
}

/** Broadcasts a real membership change to sockets currently in the Room. Never throws. */
function emitMembershipChanged(io, room, change) {
  try {
    if (!io || !room) return;
    io.to(`room:${room._id}`).emit(MEMBERSHIP_EVENT, {
      roomId: String(room._id),
      change,
      memberCount: room.memberCount,
      capacity: room.capacity,
      status: room.status,
    });
  } catch (err) {
    console.error('[roomMembership] emit failed:', err.message);
  }
}

/** Removes a user's sockets from a Room channel so broadcasts stop reaching them. Never throws. */
function leaveSocketChannel(io, userId, roomId) {
  try {
    if (io) io.in(`user:${userId}`).socketsLeave(`room:${roomId}`);
  } catch (err) {
    console.error('[roomMembership] socketsLeave failed:', err.message);
  }
}

/**
 * Account deletion: every JOINED / INVITED membership of the user becomes LEFT, the user's
 * sockets leave those Room channels, and each Room they had JOINED is recounted. Other
 * members, messages and the Rooms themselves are untouched. Safe to run more than once.
 * @returns {Promise<{ memberships: number, roomsRecounted: number }>}
 */
async function releaseUserMemberships(userId, io = null) {
  const active = await RoomMember.find({ userId, status: { $in: ['JOINED', 'INVITED'] } })
    .select('roomId status').lean();
  if (active.length === 0) return { memberships: 0, roomsRecounted: 0 };

  const joinedRoomIds = [...new Set(active.filter(m => m.status === 'JOINED').map(m => String(m.roomId)))];
  await RoomMember.updateMany(
    { _id: { $in: active.map(m => m._id) }, status: { $in: ['JOINED', 'INVITED'] } },
    { $set: { status: 'LEFT', leftAt: new Date() } }
  );

  let roomsRecounted = 0;
  for (const roomId of joinedRoomIds) {
    leaveSocketChannel(io, userId, roomId);
    try { await redisService.del?.(`presence:room:${roomId}:${userId}`); } catch (_) {}
    const room = await recountRoomMembers(roomId);
    if (room) {
      roomsRecounted++;
      emitMembershipChanged(io, room, 'LEFT');
    }
  }
  return { memberships: active.length, roomsRecounted };
}

module.exports = {
  MEMBERSHIP_EVENT,
  recountRoomMembers,
  emitMembershipChanged,
  leaveSocketChannel,
  releaseUserMemberships,
};
