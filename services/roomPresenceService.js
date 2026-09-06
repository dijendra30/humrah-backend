// services/roomPresenceService.js
// -----------------------------------------------------------------------------
// Phase 2.1: "is this member currently INSIDE this Room?"
//
// Room-specific only. Never uses global online status, app foreground, last launch,
// timers or location.
//
// Two sources, both already existing — nothing new was designed:
//   1. Socket.IO adapter room membership (`room:<roomId>`) — instant and exact for
//      sockets attached to THIS instance, with no TTL race.
//   2. Redis `presence:room:<roomId>:<userId>` (180s ±30s, refreshed by the client
//      heartbeat every 150s) — covers other instances.
//
// Source 1 exists because the Android heartbeat interval (150s) can equal the low
// end of the jittered Redis TTL (150s), so Redis alone can momentarily report a
// still-connected member as away. Checking the live socket room first removes that
// race for the common single-instance case.
// -----------------------------------------------------------------------------
'use strict';

const redisService = require('./redisService');

const presenceKey = (roomId, userId) => `presence:room:${roomId}:${userId}`;

/**
 * User ids with a live socket in this Room on THIS process.
 * @returns {Set<string>}
 */
function userIdsInSocketRoom(io, roomId) {
  const inside = new Set();
  if (!io) return inside;
  try {
    const sockets = io.sockets.adapter.rooms.get(`room:${roomId}`);
    if (!sockets) return inside;
    for (const socketId of sockets) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.userId) inside.add(String(s.userId));
    }
  } catch (err) {
    console.error('[ROOM_PRESENCE] socket room read failed:', err.message);
  }
  return inside;
}

/**
 * Of the given candidate user ids, which are currently inside the Room.
 * One pipelined Redis read for the whole set — never one call per member.
 *
 * @param {object} io
 * @param {string} roomId
 * @param {string[]} userIds
 * @returns {Promise<Set<string>>}
 */
async function getUsersInsideRoom(io, roomId, userIds) {
  const ids = (userIds || []).map(String);
  const inside = userIdsInSocketRoom(io, roomId);

  const unresolved = ids.filter(id => !inside.has(id));
  if (unresolved.length === 0) return inside;

  try {
    const hits = await redisService.getMany(unresolved.map(id => presenceKey(roomId, id)));
    for (const key of hits.keys()) {
      inside.add(key.slice(`presence:room:${roomId}:`.length));
    }
  } catch (err) {
    // Presence is a suppression signal. If Redis is unreadable we fall back to the
    // socket view only — worst case an away user gets a notification they'd have
    // been spared, never a missed message.
    console.error('[ROOM_PRESENCE] redis presence read failed:', err.message);
  }

  return inside;
}

module.exports = { getUsersInsideRoom, userIdsInSocketRoom, presenceKey };
