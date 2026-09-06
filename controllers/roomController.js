const mongoose = require('mongoose');
const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const RoomMessage = require('../models/RoomMessage');
const redisService = require('../services/redisService');
const { sendDataFcm } = require('../utils/fcmHelper');
const { normalizeReaction, serializeReactions } = require('../utils/roomReactionConfig');
const { TIER, buildDiscoveryProfile, scoreRoomForUser, compareScored } = require('../utils/roomDiscoveryRanking');
const { evaluateRoom } = require('../services/roomEngagementService');

// Safe, non-blocking analytics hook
const logRoomEvent = async (eventType, metadata = {}) => {
  try {
    console.log(`[ANALYTICS] ${eventType}`, JSON.stringify(metadata));
  } catch (err) {
    console.error('[ANALYTICS ERROR]', err);
  }
};

const { resolveRoomTopicImage, getAvailableTopics, isValidTopicForUser } = require('../utils/roomTopicConfig');

/**
 * Batch-resolves JOINED member counts for rooms whose denormalized `memberCount`
 * is not yet populated (pre-backfill window right after a deploy). One aggregation
 * for all such rooms — never one query per room. Returns a fn (room) -> count.
 */
async function memberCountResolver(rooms) {
  const missing = rooms.filter(r => typeof r.memberCount !== 'number');
  if (missing.length === 0) {
    return (room) => room.memberCount;
  }
  const agg = await RoomMember.aggregate([
    { $match: { roomId: { $in: missing.map(r => r._id) }, status: 'JOINED' } },
    { $group: { _id: '$roomId', c: { $sum: 1 } } },
  ]);
  const byRoom = new Map(agg.map(a => [String(a._id), a.c]));
  return (room) => (typeof room.memberCount === 'number'
    ? room.memberCount
    : (byRoom.get(String(room._id)) || 0));
}

exports.createRoom = async (req, res) => {
  if (process.env.ENABLE_HUMRAH_ROOMS === 'false') {
    return res.status(503).json({ success: false, message: 'Humrah Rooms are currently undergoing maintenance.' });
  }

  try {
    const { title, description, topic, capacity, discoveryMode, languages } = req.body;
    const userId = req.userId;

    if (!title || title.trim() === '') {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }
    if (title.trim().length > 30) {
      return res.status(400).json({ success: false, message: 'Title must be maximum 30 characters' });
    }

    const user = await User.findById(userId).select('questionnaire.city');
    const userCity = user?.questionnaire?.city;

    if (!isValidTopicForUser(topic, userCity)) {
      return res.status(400).json({ success: false, message: 'Invalid topic selected' });
    }

    if (!['NEAR_ME', 'ALL_INDIA'].includes(discoveryMode)) {
      return res.status(400).json({ success: false, message: 'Invalid discovery mode' });
    }
    
    const finalCapacity = parseInt(capacity);
    if (isNaN(finalCapacity) || finalCapacity < 2 || finalCapacity > 5) {
      return res.status(400).json({ success: false, message: 'Capacity must be between 2 and 5' });
    }

    const room = new HumrahRoom({
      createdBy: userId,
      discoveryMode,
      title: title.trim(),
      description: description ? description.trim() : '',
      topic,
      languages: Array.isArray(languages) ? languages : [],
      capacity: finalCapacity,
      status: 'ACTIVE',
      memberCount: 1 // creator auto-joins below
    });

    await room.save();

    const member = new RoomMember({
      roomId: room._id,
      userId,
      role: 'HOST',
      status: 'JOINED'
    });

    await member.save();

    // Sync topic to user profile idempotently
    try {
      await User.updateOne(
        { _id: userId },
        { $addToSet: { 'questionnaire.humrahRoomInterests': topic } }
      );
    } catch (profileErr) {
      console.error('[createRoom] Failed to sync profile topic:', profileErr);
    }

    await redisService.setWithJitter(`room:transient:${room._id}`, { status: 'ACTIVE', createdBy: userId }, 86400, 3600);

    logRoomEvent('ROOM_CREATED', { roomId: room._id, userId, mode: discoveryMode });

    return res.status(201).json({
      success: true,
      room: {
        roomId: room._id,
        title: room.title,
        description: room.description,
        topic: room.topic,
        imageUrl: resolveRoomTopicImage(room.topic),
        languages: room.languages,
        discoveryMode: room.discoveryMode,
        memberCount: 1,
        capacity: room.capacity,
        status: room.status,
        lastMessageAt: null,
        lastMessage: null,
        createdAt: room.createdAt
      }
    });

  } catch (error) {
    console.error('[createRoom error]', error);
    return res.status(500).json({ success: false, message: 'Server error creating room' });
  }
};

// Helper: Haversine distance
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

/**
 * R4.5 — assembles the discoverable Room inventory for one user and ranks it.
 *
 * Bounded query budget regardless of Room count:
 *   1 rooms   +  (0|1) memberCount backfill  +  1 memberships  +  1 blocked-members
 *
 * Guarantees (see INVARIANTS in the R4.5 report):
 *   - a Room the user has JOINED is never returned
 *   - one user joining never removes the Room for anyone else (per-user filter only)
 *   - FULL / CLOSED / INACTIVE / at-capacity Rooms are never returned
 *   - member counts are the real denormalized values; nothing is fabricated
 */
async function buildDiscoveryInventory({ userId, user, excludeIds, joinedRoomIds, preferredMode, seededRooms }) {
  const MAX_RESULTS = 40;
  const joinedSet = new Set((joinedRoomIds || []).map(String));

  // 1. Every Room that is structurally open to being joined right now.
  //    SUGGESTED is included — that is the state the System Room generator emits.
  const candidates = await HumrahRoom.find({
    status: { $in: ['ACTIVE', 'SUGGESTED'] },
    discoveryMode: { $in: ['NEAR_ME', 'ALL_INDIA'] },
  })
    .sort({ createdAt: -1 })
    .limit(120)
    .lean();

  const open = candidates.filter(r => !joinedSet.has(String(r._id)));
  if (open.length === 0) return seededRooms || [];

  // 2. Real member counts (denormalized; falls back to one batch aggregation only
  //    for Rooms the memberCount backfill has not touched yet).
  const countOf = await memberCountResolver(open);

  // 3. This user's non-JOINED membership state, for the invitation signal.
  const myMemberships = await RoomMember.find({
    userId,
    roomId: { $in: open.map(r => r._id) },
  }).select('roomId status').lean();
  const myStatusByRoom = new Map(myMemberships.map(m => [String(m.roomId), m.status]));

  // 4. Block safety. User-created Rooms are already screened by excludeIds above;
  //    SYSTEM Rooms have no creator, so screen them by their JOINED members.
  //    ONE query for every candidate Room.
  const blockSet = new Set((excludeIds || []).map(String));
  const joinedMembers = await RoomMember.find({
    roomId: { $in: open.map(r => r._id) },
    status: 'JOINED',
  }).select('roomId userId').lean();
  const blockedRoomIds = new Set();
  joinedMembers.forEach(m => {
    if (blockSet.has(String(m.userId))) blockedRoomIds.add(String(m.roomId));
  });

  const profile = buildDiscoveryProfile(user);
  const now = Date.now();

  const scored = [];
  for (const room of open) {
    const rid = String(room._id);
    if (blockedRoomIds.has(rid)) continue;

    const memberCount = countOf(room) || 0;
    // Capacity is enforced server-side; never trust the client to hide a full Room.
    if (memberCount >= (room.capacity || 0)) continue;

    const myStatus = myStatusByRoom.get(rid) || null;
    if (myStatus === 'JOINED') continue;          // defensive — already filtered
    if (myStatus === 'KICKED') continue;

    const { score, tier, reasons } = scoreRoomForUser(room, profile, {
      memberCount,
      isInvited: myStatus === 'INVITED',
      now,
    });
    scored.push({ room, score, tier, reasons, memberCount, myStatus });
  }

  scored.sort(compareScored);

  // 5. Progressive fallback so the dashboard is not needlessly empty. Personalized
  //    Rooms first; broader tiers are appended only while inventory is thin. Every
  //    tier is a REAL, joinable Room — nothing synthetic is added.
  const byTier = (t) => scored.filter(s => s.tier === t);
  const ordered = [
    ...byTier(TIER.PERSONAL),
    ...byTier(TIER.RELEVANT),
    ...byTier(TIER.BROWSE),
  ].slice(0, MAX_RESULTS);

  // Preserve the distanceTier the geo path already computed for user-created Rooms.
  const seededById = new Map((seededRooms || []).map(r => [String(r.roomId), r]));

  return ordered.map(({ room, tier, reasons, memberCount, myStatus }) => {
    const seeded = seededById.get(String(room._id));
    const capacity = room.capacity || 0;
    return {
      roomId: room._id,
      title: room.title,
      description: room.description,
      topic: room.topic,
      imageUrl: resolveRoomTopicImage(room.topic),
      languages: room.languages,
      discoveryMode: room.discoveryMode,
      capacity,
      maxMembers: capacity,
      memberCount,
      remainingCapacity: Math.max(0, capacity - memberCount),
      status: room.status,
      creationSource: room.creationSource || 'USER',
      myMembershipStatus: myStatus,          // 'INVITED' or null — never 'JOINED' here
      discoveryTier: tier,
      matchReasons: reasons,                 // coarse labels only, no scores exposed
      distanceTier: seeded?.distanceTier
        || (room.discoveryMode === 'NEAR_ME' ? 'Near Me' : 'All India'),
      lastMessageAt: null,
      lastMessage: null,
      createdAt: room.createdAt,
    };
  });
}

exports.discoverRooms = async (req, res) => {
  if (process.env.ENABLE_HUMRAH_ROOMS === 'false') {
    return res.status(503).json({ success: false, message: 'Humrah Rooms are currently undergoing maintenance.' });
  }

  try {
    const { discoveryMode } = req.body;
    const userId = req.userId;

    // R4.5: questionnaire is needed for relevance ranking (existing explicit fields only).
    const user = await User.findById(userId)
      .select('status suspensionInfo blockedUsers liveLocation questionnaire');
    if (!user || user.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'Account not eligible for discovery' });
    }

    const excludeIds = [userId, ...(user.blockedUsers || [])];
    const usersWhoBlockedMe = await User.find({ blockedUsers: userId }, { _id: 1 });
    excludeIds.push(...usersWhoBlockedMe.map(u => u._id));

    const baseFilter = {
      _id: { $nin: excludeIds },
      status: 'ACTIVE',
      userType: { $ne: 'COMPANION' }
    };

    const myMemberships = await RoomMember.find({ userId, status: 'JOINED' }).select('roomId');
    const myRoomIds = myMemberships.map(m => m.roomId);

    let discoveredRooms = [];
    const userLat = user.liveLocation?.lat || user.last_known_lat;
    const userLng = user.liveLocation?.lng || user.last_known_lng;

    if (discoveryMode === 'NEAR_ME') {
      if (!userLat || !userLng) {
        return res.status(400).json({ success: false, message: 'Location is required for nearby Rooms' });
      }

      const radii = [5000, 8000, 10000, 15000];
      for (const radius of radii) {
        const nearbyUsers = await User.find({
          ...baseFilter,
          liveLocation: {
            $near: {
              $geometry: { type: 'Point', coordinates: [userLng, userLat] },
              $maxDistance: radius
            }
          }
        }).select('_id liveLocation');

        const nearbyUserMap = new Map();
        nearbyUsers.forEach(u => nearbyUserMap.set(u._id.toString(), u));

        const nearbyUserIds = Array.from(nearbyUserMap.keys());

        const rooms = await HumrahRoom.find({
          createdBy: { $in: nearbyUserIds },
          status: 'ACTIVE',
          discoveryMode: 'NEAR_ME',
          _id: { $nin: myRoomIds }
        }).limit(20);

        if (rooms.length > 0) {
          const countOf = await memberCountResolver(rooms);
          discoveredRooms = rooms.map((room) => {
            const creator = nearbyUserMap.get(room.createdBy.toString());
            const dist = getDistance(userLat, userLng, creator.liveLocation?.lat, creator.liveLocation?.lng);
            const distanceTier = dist <= 5 ? '< 5 km' : dist <= 8 ? '5-8 km' : dist <= 10 ? '8-10 km' : '10-15 km';
            return {
              roomId: room._id,
              title: room.title,
              description: room.description,
              topic: room.topic,
              imageUrl: resolveRoomTopicImage(room.topic),
              languages: room.languages,
              discoveryMode: room.discoveryMode,
              capacity: room.capacity,
              memberCount: countOf(room),
              status: room.status,
              distanceTier,
              lastMessageAt: null,
              lastMessage: null,
              createdAt: room.createdAt
            };
          });
          break;
        }
      }
    } else if (discoveryMode === 'ALL_INDIA') {
      const rooms = await HumrahRoom.find({
        status: 'ACTIVE',
        discoveryMode: 'ALL_INDIA',
        createdBy: { $nin: excludeIds },
        _id: { $nin: myRoomIds }
      }).limit(50);

      const countOf = await memberCountResolver(rooms);
      discoveredRooms = rooms.map((room) => ({
        roomId: room._id,
        title: room.title,
        description: room.description,
        topic: room.topic,
        imageUrl: resolveRoomTopicImage(room.topic),
        languages: room.languages,
        discoveryMode: room.discoveryMode,
        capacity: room.capacity,
        memberCount: countOf(room),
        status: room.status,
        distanceTier: 'All India',
        lastMessageAt: null,
        lastMessage: null,
        createdAt: room.createdAt
      }));
    } else {
      return res.status(400).json({ success: false, message: 'Invalid discovery mode' });
    }

    // ── R4.5: recruitment inventory + ranking ────────────────────────────────
    // The block above is the pre-existing user-created-Room discovery, unchanged.
    // SYSTEM-generated Rooms are SUGGESTED and have no createdBy, so they could
    // never match those filters — which is why the generator's output was never
    // discoverable. buildDiscoveryInventory() adds them (plus any open Room the
    // strict filters missed), applies per-user membership/capacity/block rules,
    // ranks everything, and guarantees a non-empty dashboard when real inventory
    // exists. It never fabricates Rooms or member counts.
    const ranked = await buildDiscoveryInventory({
      userId,
      user,
      excludeIds,
      joinedRoomIds: myRoomIds,
      preferredMode: discoveryMode,
      seededRooms: discoveredRooms,
    });

    return res.status(200).json({ success: true, rooms: ranked });

  } catch (error) {
    console.error('[discoverRooms error]', error);
    return res.status(500).json({ success: false, message: 'Server error during discovery' });
  }
};

exports.joinRoom = async (req, res) => {
  if (process.env.ENABLE_HUMRAH_ROOMS === 'false') {
    return res.status(503).json({ success: false, message: 'Humrah Rooms are currently undergoing maintenance.' });
  }

  const { roomId } = req.params;
  const userId = req.userId;
  const lockKey = `lock:room_join:${roomId}`;
  let lockAcquired = false;

  try {
    const user = await User.findById(userId).select('status blockedUsers');
    if (!user || user.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'Account not eligible to join' });
    }

    lockAcquired = await redisService.acquireLock(lockKey, 10);
    if (!lockAcquired) {
      return res.status(429).json({ success: false, message: 'Room is currently busy, please try again.' });
    }

    const room = await HumrahRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    if (['FULL', 'INACTIVE', 'CLOSED'].includes(room.status)) {
      return res.status(400).json({ success: false, message: `Cannot join room. Status is ${room.status}` });
    }

    const existingMember = await RoomMember.findOne({ roomId, userId });
    if (existingMember && existingMember.status === 'JOINED') {
      return res.status(400).json({ success: false, message: 'Already a member of this room' });
    }

    // Current JOINED members (one query — also gives us the authoritative count).
    const joinedMembers = await RoomMember.find({ roomId, status: 'JOINED' }).select('userId');
    const currentMemberCount = joinedMembers.length;

    // ── Block-pair check ──────────────────────────────────────────────────────
    // Reject if the joining user has blocked, OR is blocked by, the room creator
    // or any current JOINED member. Response is deliberately generic — it never
    // reveals which user, or that a block exists.
    const counterpartIds = new Set([String(room.createdBy)]);
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
        return res.status(403).json({ success: false, message: "You can't join this Room right now." });
      }
    }

    if (currentMemberCount >= room.capacity) {
      room.status = 'FULL';
      room.memberCount = currentMemberCount;
      await room.save();
      logRoomEvent('ROOM_BECAME_FULL', { roomId });
      return res.status(400).json({ success: false, message: 'Room is at full capacity' });
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

    logRoomEvent('ROOM_JOINED', { roomId, userId });

    return res.status(200).json({
      success: true,
      message: 'Successfully joined room',
      room: {
        roomId: room._id,
        topic: room.topic,
        status: room.status,
        memberCount: newMemberCount
      }
    });

  } catch (error) {
    console.error('[joinRoom error]', error);
    return res.status(500).json({ success: false, message: 'Server error joining room' });
  } finally {
    if (lockAcquired) {
      await redisService.releaseLock(lockKey);
    }
  }
};

exports.leaveRoom = async (req, res) => {
  if (process.env.ENABLE_HUMRAH_ROOMS === 'false') {
    return res.status(503).json({ success: false, message: 'Humrah Rooms are currently undergoing maintenance.' });
  }

  const { roomId } = req.params;
  const userId = req.userId;
  const lockKey = `lock:room_join:${roomId}`;
  let lockAcquired = false;

  try {
    lockAcquired = await redisService.acquireLock(lockKey, 10);
    if (!lockAcquired) {
      return res.status(429).json({ success: false, message: 'Room is currently busy, please try again.' });
    }

    const room = await HumrahRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    const membership = await RoomMember.findOne({ roomId, userId, status: 'JOINED' });
    if (!membership) {
      return res.status(400).json({ success: false, message: 'Not an active member of this room' });
    }

    membership.status = 'LEFT';
    membership.leftAt = new Date();
    await membership.save();

    if (redisService.del) {
      await redisService.del(`presence:room:${roomId}:${userId}`);
    }

    // Authoritative recount under the room lock; keep the denormalized field in sync.
    const newMemberCount = await RoomMember.countDocuments({ roomId, status: 'JOINED' });
    room.memberCount = newMemberCount;
    if (room.status === 'FULL' && newMemberCount < room.capacity) {
      room.status = 'ACTIVE';
      logRoomEvent('ROOM_REOPENED_FROM_FULL', { roomId });
    }
    await room.save();

    logRoomEvent('ROOM_LEFT', { roomId, userId });
    return res.status(200).json({ success: true, message: 'Successfully left room' });

  } catch (error) {
    console.error('[leaveRoom error]', error);
    return res.status(500).json({ success: false, message: 'Server error leaving room' });
  } finally {
    if (lockAcquired) {
      await redisService.releaseLock(lockKey);
    }
  }
};

exports.getMyRooms = async (req, res) => {
  try {
    const userId = req.userId;
    const memberships = await RoomMember.find({ userId, status: 'JOINED' }).select('roomId lastReadAt');
    const roomIds = memberships.map(m => m.roomId);
    // Phase 2.1: server-authoritative read state for the Sessions dot.
    const lastReadByRoom = new Map(memberships.map(m => [String(m.roomId), m.lastReadAt || null]));
    // Most recently active first (null lastMessageAt sorts last in desc order).
    const rooms = await HumrahRoom.find({ _id: { $in: roomIds } }).sort({ lastMessageAt: -1, createdAt: -1 });

    if (rooms.length === 0) {
      return res.status(200).json({ success: true, rooms: [] });
    }

    // ── One aggregation for the newest TEXT message per room (no N+1) ──────────
    const lastMsgs = await RoomMessage.aggregate([
      { $match: { roomId: { $in: rooms.map(r => r._id) }, messageType: 'TEXT' } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$roomId', content: { $first: '$content' }, senderId: { $first: '$senderId' }, createdAt: { $first: '$createdAt' } } },
    ]);
    const lastByRoom = new Map(lastMsgs.map(m => [String(m._id), m]));

    // One query for the sender first-names referenced by those messages.
    const senderIds = [...new Set(lastMsgs.map(m => String(m.senderId)))];
    const senders = senderIds.length
      ? await User.find({ _id: { $in: senderIds } }).select('firstName')
      : [];
    const nameById = new Map(senders.map(u => [String(u._id), u.firstName || 'Someone']));

    const countOf = await memberCountResolver(rooms);

    const formattedRooms = rooms.map((room) => {
      const lm = lastByRoom.get(String(room._id));
      // lastMessageAt is derived from an ACTUAL persisted message, never the room
      // field alone — a room with no messages reports null even if a legacy
      // default left a stale timestamp on the document.
      const lastMessage = lm ? `${nameById.get(String(lm.senderId)) || 'Someone'}: ${lm.content}` : null;
      const lastMessageAt = lm ? new Date(lm.createdAt).toISOString() : null;

      // Phase 2.1 Sessions dot semantics:
      //   no messages            -> no dot
      //   messages, all read     -> GREEN  (hasMessages && !hasUnreadMessages)
      //   new since lastReadAt   -> YELLOW (hasUnreadMessages)
      const lastReadAt = lastReadByRoom.get(String(room._id));
      const hasMessages = !!lm;
      const hasUnreadMessages = hasMessages && (!lastReadAt || new Date(lm.createdAt) > new Date(lastReadAt));

      return {
        hasMessages,
        hasUnreadMessages,
        roomId: room._id,
        title: room.title,
        description: room.description,
        topic: room.topic,
        imageUrl: resolveRoomTopicImage(room.topic),
        languages: room.languages,
        discoveryMode: room.discoveryMode,
        capacity: room.capacity,
        memberCount: countOf(room),
        status: room.status,
        distanceTier: null,
        lastMessageAt,
        lastMessage,
        createdAt: room.createdAt,
      };
    });

    res.status(200).json({ success: true, rooms: formattedRooms });
  } catch (error) {
    console.error('[getMyRooms error]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getRoomDetails = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    const member = await RoomMember.findOne({ roomId, userId, status: { $in: ['JOINED', 'INVITED'] } });
    if (!member) return res.status(403).json({ success: false, message: 'Not a member' });

    const room = await HumrahRoom.findById(roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Not found' });
    
    const members = await RoomMember.find({ roomId, status: 'JOINED' }).populate('userId', 'firstName lastName profilePhoto');
    
    const roomFormatted = {
      roomId: room._id,
      title: room.title,
      description: room.description,
      topic: room.topic,
      imageUrl: resolveRoomTopicImage(room.topic),
      languages: room.languages,
      discoveryMode: room.discoveryMode,
      capacity: room.capacity,
      status: room.status,
      // members[] is already loaded for the payload below; use it as the fallback
      // for rooms not yet touched by the memberCount backfill.
      memberCount: typeof room.memberCount === 'number' ? room.memberCount : members.length,
      lastMessageAt: room.lastMessageAt ? room.lastMessageAt.toISOString() : null,
      createdAt: room.createdAt,
      createdBy: room.createdBy,
      // PHASE 2: the caller's own membership state ('JOINED' | 'INVITED'), so the
      // invitation screen can show "Open Room" vs "Join Room" instead of offering
      // Join to someone who already joined. Additive — existing clients ignore it.
      myMembershipStatus: member.status
    };

    // R5.1 — derived engagement condition of the conversation. Aggregate counts
    // only: no user identities, no per-user timestamps, no presence identities.
    // Already behind this endpoint's membership check, so only JOINED/INVITED
    // members of THIS Room can see it. Advisory — a failure returns null and
    // never breaks the Room read.
    const engagement = await evaluateRoom(room);

    res.status(200).json({ success: true, room: roomFormatted, members, engagement });
  } catch (error) {
    console.error('[getRoomDetails error]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getRoomMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    const member = await RoomMember.findOne({ roomId, userId, status: 'JOINED' });
    if (!member) return res.status(403).json({ success: false, message: 'Not a member' });

    const messages = await RoomMessage.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate('senderId', 'firstName lastName');

    const formattedMessages = messages.map(msg => ({
      _id: msg._id,
      roomId: msg.roomId,
      senderId: msg.senderId?._id || msg.senderId,
      senderName: msg.senderId
        ? (`${msg.senderId.firstName || ''} ${msg.senderId.lastName || ''}`.trim() || 'Member')
        : 'Member',
      messageType: msg.messageType,
      content: msg.content,
      clientMessageId: msg.clientMessageId || null,
      reactions: serializeReactions(msg.reactions, userId),
      createdAt: msg.createdAt
    }));

    res.status(200).json({ success: true, messages: formattedMessages });
  } catch (error) {
    console.error('[getRoomMessages error]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2.1 — server-authoritative read state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/rooms/:roomId/read
 * Marks the Room read for the caller. Only a JOINED member may do this —
 * INVITED / LEFT / KICKED are rejected. Never called by notification delivery.
 */
exports.markRoomRead = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.userId;

    const updated = await RoomMember.findOneAndUpdate(
      { roomId, userId, status: 'JOINED' },
      { $set: { lastReadAt: new Date() } },
      { new: true }
    ).select('lastReadAt');

    if (!updated) {
      return res.status(403).json({ success: false, message: 'Not an active member of this room' });
    }
    return res.status(200).json({
      success: true,
      message: 'Room marked read',
      lastReadAt: updated.lastReadAt.toISOString(),
    });
  } catch (error) {
    console.error('[markRoomRead error]', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2.1 — message reactions
// ─────────────────────────────────────────────────────────────────────────────

/** Shared guard: caller must be a JOINED member and the message must be in the Room. */
async function loadReactableMessage(roomId, messageId, userId) {
  const member = await RoomMember.findOne({ roomId, userId, status: 'JOINED' }).select('_id').lean();
  if (!member) return { error: { code: 403, message: 'Not an active member of this room' } };

  const message = await RoomMessage.findOne({ _id: messageId, roomId }).select('_id').lean();
  if (!message) return { error: { code: 404, message: 'Message not found in this room' } };

  return { ok: true };
}

/** Broadcasts the authoritative reaction state to members currently in the Room. */
function broadcastReactions(req, roomId, messageId, reactions) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    // Viewer-agnostic payload — each client marks its own `reacted` locally.
    io.to(`room:${roomId}`).emit('reaction_updated', {
      roomId: String(roomId),
      messageId: String(messageId),
      reactions: (reactions || [])
        .filter(r => r.userIds && r.userIds.length > 0)
        .map(r => ({
          emoji: r.emoji,
          count: r.userIds.length,
          userIds: r.userIds.map(String),
        })),
    });
  } catch (err) {
    console.error('[roomReaction] broadcast failed:', err.message);
  }
}

/**
 * POST /api/rooms/:roomId/messages/:messageId/reaction   { emoji }
 * Adds or CHANGES the caller's reaction. A user holds at most one emoji per
 * message; posting a different emoji moves them.
 *
 * Concurrency-safe: a single aggregation-pipeline update performs
 * "remove me from every bucket, then add me to the target, then drop empty buckets"
 * atomically inside the document — no read-modify-write race.
 */
exports.addRoomMessageReaction = async (req, res) => {
  try {
    const { roomId, messageId } = req.params;
    const userId = req.userId;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: 'Invalid message id' });
    }
    const emoji = normalizeReaction(req.body?.emoji);
    if (!emoji) {
      return res.status(400).json({ success: false, message: 'Unsupported reaction' });
    }

    const guard = await loadReactableMessage(roomId, messageId, userId);
    if (guard.error) {
      return res.status(guard.error.code).json({ success: false, message: guard.error.message });
    }

    const uid = new mongoose.Types.ObjectId(String(userId));
    const updated = await RoomMessage.findOneAndUpdate(
      { _id: messageId, roomId },
      [{
        $set: {
          reactions: {
            $let: {
              vars: {
                stripped: {
                  $map: {
                    input: { $ifNull: ['$reactions', []] },
                    as: 'r',
                    in: {
                      emoji: '$$r.emoji',
                      userIds: {
                        $filter: { input: '$$r.userIds', as: 'u', cond: { $ne: ['$$u', uid] } },
                      },
                    },
                  },
                },
              },
              in: {
                $filter: {
                  input: {
                    $cond: [
                      { $in: [emoji, { $map: { input: '$$stripped', as: 's', in: '$$s.emoji' } }] },
                      {
                        $map: {
                          input: '$$stripped',
                          as: 'r',
                          in: {
                            emoji: '$$r.emoji',
                            userIds: {
                              $cond: [
                                { $eq: ['$$r.emoji', emoji] },
                                { $concatArrays: ['$$r.userIds', [uid]] },
                                '$$r.userIds',
                              ],
                            },
                          },
                        },
                      },
                      { $concatArrays: ['$$stripped', [{ emoji, userIds: [uid] }]] },
                    ],
                  },
                  as: 'r',
                  cond: { $gt: [{ $size: '$$r.userIds' }, 0] },
                },
              },
            },
          },
        },
      }],
      { new: true }
    ).select('reactions');

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Message not found in this room' });
    }

    broadcastReactions(req, roomId, messageId, updated.reactions);
    return res.status(200).json({
      success: true,
      messageId: String(messageId),
      reactions: serializeReactions(updated.reactions, userId),
    });
  } catch (error) {
    console.error('[addRoomMessageReaction error]', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * DELETE /api/rooms/:roomId/messages/:messageId/reaction
 * Removes the caller's reaction (whichever emoji it was). Idempotent.
 */
exports.removeRoomMessageReaction = async (req, res) => {
  try {
    const { roomId, messageId } = req.params;
    const userId = req.userId;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: 'Invalid message id' });
    }

    const guard = await loadReactableMessage(roomId, messageId, userId);
    if (guard.error) {
      return res.status(guard.error.code).json({ success: false, message: guard.error.message });
    }

    const uid = new mongoose.Types.ObjectId(String(userId));
    const updated = await RoomMessage.findOneAndUpdate(
      { _id: messageId, roomId },
      [{
        $set: {
          reactions: {
            $filter: {
              input: {
                $map: {
                  input: { $ifNull: ['$reactions', []] },
                  as: 'r',
                  in: {
                    emoji: '$$r.emoji',
                    userIds: {
                      $filter: { input: '$$r.userIds', as: 'u', cond: { $ne: ['$$u', uid] } },
                    },
                  },
                },
              },
              as: 'r',
              cond: { $gt: [{ $size: '$$r.userIds' }, 0] },
            },
          },
        },
      }],
      { new: true }
    ).select('reactions');

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Message not found in this room' });
    }

    broadcastReactions(req, roomId, messageId, updated.reactions);
    return res.status(200).json({
      success: true,
      messageId: String(messageId),
      reactions: serializeReactions(updated.reactions, userId),
    });
  } catch (error) {
    console.error('[removeRoomMessageReaction error]', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getTopics = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('questionnaire.city');
    const city = user?.questionnaire?.city;
    
    const topics = getAvailableTopics(city);
    return res.status(200).json({ success: true, topics });
  } catch (error) {
    console.error('[getTopics error]', error);
    return res.status(500).json({ success: false, message: 'Server error fetching topics' });
  }
};
