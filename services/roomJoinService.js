// services/roomJoinService.js
// -----------------------------------------------------------------------------
// The ONE place a user joins a Humrah Room.
//
// This is the body of roomController.joinRoom, moved here unchanged so the group
// invitation service (services/invitations/) can reuse the exact same rules, lock,
// capacity handling, block checks and realtime event instead of re-implementing
// them. roomController.joinRoom now calls this and sends the result as before:
// same HTTP status, same JSON body, same log lines.
//
// The only new input is `viaInvite`. A PRIVATE Room is joinable only by someone
// invited to it; a valid invitation link (checked by the invitation service before
// this is called) is such an invitation. Nothing else changes for invite joins.
//
// Result: { status, body, code } — `code` is for internal callers only and is
// never added to the HTTP body (the existing endpoint's responses are unchanged).
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const redisService = require('./redisService');
const { emitMembershipChanged } = require('./roomMembershipService');

const logRoomEvent = async (eventType, metadata = {}) => {
  try {
    console.log(`[ANALYTICS] ${eventType}`, JSON.stringify(metadata));
  } catch (err) {
    console.error('[ANALYTICS ERROR]', err);
  }
};

const result = (status, code, body) => ({ status, code, body });

/**
 * @param {object} p
 * @param {string|ObjectId} p.userId   the joining user
 * @param {string|ObjectId} p.roomId   the Room
 * @param {object}  [p.io]             socket.io server (realtime membership event)
 * @param {boolean} [p.viaInvite]      the caller verified an invitation link for this Room
 */
async function joinRoomAsUser({ userId, roomId, io, viaInvite = false }) {
  const lockKey = `lock:room_join:${roomId}`;
  let lockAcquired = false;

  try {
    const user = await User.findById(userId).select('status blockedUsers');
    if (!user || user.status !== 'ACTIVE') {
      return result(403, 'ACCOUNT_NOT_ELIGIBLE', { success: false, message: 'Account not eligible to join' });
    }

    lockAcquired = await redisService.acquireLock(lockKey, 10);
    if (!lockAcquired) {
      return result(429, 'BUSY', { success: false, message: 'Room is currently busy, please try again.' });
    }

    const room = await HumrahRoom.findById(roomId);
    if (!room) {
      return result(404, 'NOT_FOUND', { success: false, message: 'Room not found' });
    }

    if (['FULL', 'INACTIVE', 'CLOSED'].includes(room.status)) {
      const code = room.status === 'FULL' ? 'FULL' : 'CLOSED';
      return result(400, code, { success: false, message: `Cannot join room. Status is ${room.status}` });
    }

    const existingMember = await RoomMember.findOne({ roomId, userId });
    if (existingMember && existingMember.status === 'JOINED') {
      return result(400, 'ALREADY_MEMBER', { success: false, message: 'Already a member of this room' });
    }
    // Phase 2.3: a removed member cannot re-add themselves (KICKED used to flip back to
    // JOINED below). Same generic reply as a block, so nothing is revealed.
    if (existingMember && existingMember.status === 'KICKED') {
      return result(403, 'KICKED', { success: false, message: "You can't join this Room right now." });
    }
    // Phase 2.3: a PRIVATE Room is joinable only by someone invited to it. Answered as
    // "not found" so a guessed id does not confirm that the Room exists.
    if (room.discoveryMode === 'PRIVATE' && !viaInvite && !(existingMember && existingMember.status === 'INVITED')) {
      return result(404, 'NOT_FOUND', { success: false, message: 'Room not found' });
    }

    // Current JOINED members (one query — also gives us the authoritative count).
    const joinedMembers = await RoomMember.find({ roomId, status: 'JOINED' }).select('userId');
    const currentMemberCount = joinedMembers.length;

    // ── Block-pair check ──────────────────────────────────────────────────────
    // Reject if the joining user has blocked, OR is blocked by, the room creator
    // or any current JOINED member. Response is deliberately generic — it never
    // reveals which user, or that a block exists.
    // A SYSTEM-generated Room has no creator (HumrahRoom.createdBy is only required
    // when creationSource === 'USER'). String(null) === "null" would be cast as an
    // ObjectId below and throw, so a creator only joins the set when one exists.
    const counterpartIds = new Set(room.createdBy ? [String(room.createdBy)] : []);
    joinedMembers.forEach(m => counterpartIds.add(String(m.userId)));
    counterpartIds.delete(String(userId));
    if (counterpartIds.size > 0) {
      const ids = Array.from(counterpartIds);
      const iBlockedThem = (user.blockedUsers || []).some(b => counterpartIds.has(String(b)));
      let theyBlockedMe = false;
      if (!iBlockedThem) {
        theyBlockedMe = !!(await User.exists({ _id: { $in: ids }, blockedUsers: userId }));
      }
      if (iBlockedThem || theyBlockedMe) {
        return result(403, 'BLOCKED', { success: false, message: "You can't join this Room right now." });
      }
    }

    if (currentMemberCount >= room.capacity) {
      room.status = 'FULL';
      room.memberCount = currentMemberCount;
      await room.save();
      logRoomEvent('ROOM_BECAME_FULL', { roomId });
      return result(400, 'FULL', { success: false, message: 'Room is at full capacity' });
    }

    if (existingMember) {
      existingMember.status = 'JOINED';
      existingMember.joinedAt = new Date();
      await existingMember.save();
    } else {
      await RoomMember.create({
        roomId,
        userId,
        role: 'PARTICIPANT',
        status: 'JOINED'
      });
    }

    const newMemberCount = currentMemberCount + 1;
    room.memberCount = newMemberCount; // maintained under the room lock
    if (newMemberCount >= room.capacity) {
      room.status = 'FULL';
      logRoomEvent('ROOM_BECAME_FULL', { roomId });
    } else if (room.status === 'SUGGESTED' && newMemberCount >= 2) {
      room.status = 'ACTIVE';
      logRoomEvent('ROOM_BECAME_ACTIVE', { roomId });
    }
    await room.save();

    logRoomEvent('ROOM_JOINED', { roomId, userId, ...(viaInvite ? { via: 'INVITE' } : {}) });
    emitMembershipChanged(io, room, 'JOINED');

    return result(200, 'JOINED', {
      success: true,
      message: 'Successfully joined room',
      room: {
        roomId: room._id,
        topic: room.topic,
        status: room.status,
        memberCount: newMemberCount
      }
    });
  } finally {
    if (lockAcquired) {
      await redisService.releaseLock(lockKey);
    }
  }
}

module.exports = { joinRoomAsUser };
