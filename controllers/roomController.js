const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const RoomMessage = require('../models/RoomMessage');
const redisService = require('../services/redisService');
const { sendDataFcm } = require('../utils/fcmHelper');

// Safe, non-blocking analytics hook
const logRoomEvent = async (eventType, metadata = {}) => {
  try {
    // In a real implementation, this would save to an AnalyticsEvent collection
    // For Phase 1B, we log it so it can be parsed or later implemented.
    console.log(`[ANALYTICS] ${eventType}`, JSON.stringify(metadata));
  } catch (err) {
    console.error('[ANALYTICS ERROR]', err);
  }
};

const CANONICAL_TOPICS = [
  "Movies & Series", "Food & Cooking", "Music", "Gaming", "Travel & Exploring",
  "Sports", "Study & Learning", "Books & Reading", "Technology", "Photography & Content Creation",
  "Fitness & Wellness", "Fashion & Style", "Art & Creativity", "Career & Work", "Startups & Business",
  "College & Campus Life", "Current Topics", "Life & Experiences", "Personal Growth", "Relationships & Friendships",
  "Chill & Casual Conversations", "Deep Conversations", "Local Hangouts", "Cafés & Food Spots", "Weekend Plans",
  "City Exploration", "Events & Activities", "Random Fun Discussions", "Memes & Internet Culture", "Pop Culture",
  "Anime & Manga", "TV Shows & Fandoms", "Creative Writing & Storytelling", "Language & Culture", "Just Meeting New People"
];

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

    if (!CANONICAL_TOPICS.includes(topic)) {
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
      status: 'ACTIVE' // User-created rooms are immediately active
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

    // BASE TTL = 24 HOURS (86400s), JITTER = 1 HOUR (3600s)
    await redisService.setWithJitter(`room:transient:${room._id}`, { status: 'ACTIVE', createdBy: userId }, 86400, 3600);

    logRoomEvent('ROOM_CREATED', { roomId: room._id, userId, mode: discoveryMode });

    return res.status(201).json({
      success: true,
      room: {
        roomId: room._id,
        title: room.title,
        description: room.description,
        topic: room.topic,
        languages: room.languages,
        discoveryMode: room.discoveryMode,
        memberCount: 1,
        capacity: room.capacity,
        status: room.status,
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
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

exports.discoverRooms = async (req, res) => {
  if (process.env.ENABLE_HUMRAH_ROOMS === 'false') {
    return res.status(503).json({ success: false, message: 'Humrah Rooms are currently undergoing maintenance.' });
  }

  try {
    const { discoveryMode } = req.body;
    const userId = req.userId;

    const user = await User.findById(userId).select('status suspensionInfo blockedUsers liveLocation');
    if (!user || user.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'Account not eligible for discovery' });
    }

    // Hard filters
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
        return res.status(400).json({ success: false, message: 'Valid location required for Near Me mode' });
      }

      const radii = [5000, 8000, 10000, 15000];
      for (const radius of radii) {
        // Find users near me
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

        // Find active rooms created by these users that I am not already in
        const rooms = await HumrahRoom.find({
          createdBy: { $in: nearbyUserIds },
          status: 'ACTIVE',
          discoveryMode: 'NEAR_ME',
          _id: { $nin: myRoomIds }
        }).limit(20);

        if (rooms.length > 0) {
          discoveredRooms = await Promise.all(rooms.map(async (room) => {
            const creator = nearbyUserMap.get(room.createdBy.toString());
            const dist = getDistance(userLat, userLng, creator.liveLocation?.lat, creator.liveLocation?.lng);
            const distanceTier = dist <= 5 ? '< 5 km' : dist <= 8 ? '5-8 km' : dist <= 10 ? '8-10 km' : '10-15 km';
            const memberCount = await RoomMember.countDocuments({ roomId: room._id, status: 'JOINED' });
            return {
              roomId: room._id,
              title: room.title,
              description: room.description,
              topic: room.topic,
              languages: room.languages,
              discoveryMode: room.discoveryMode,
              capacity: room.capacity,
              memberCount,
              status: room.status,
              distanceTier,
              createdAt: room.createdAt
            };
          }));
          break; // Stop progressive expansion if we found rooms
        }
      }
    } else if (discoveryMode === 'ALL_INDIA') {
      const rooms = await HumrahRoom.find({
        status: 'ACTIVE',
        discoveryMode: 'ALL_INDIA',
        createdBy: { $nin: excludeIds },
        _id: { $nin: myRoomIds }
      }).limit(50);
      
      discoveredRooms = await Promise.all(rooms.map(async (room) => {
        const memberCount = await RoomMember.countDocuments({ roomId: room._id, status: 'JOINED' });
        return {
          roomId: room._id,
          title: room.title,
          description: room.description,
          topic: room.topic,
          languages: room.languages,
          discoveryMode: room.discoveryMode,
          capacity: room.capacity,
          memberCount,
          status: room.status,
          distanceTier: 'All India',
          createdAt: room.createdAt
        };
      }));
    } else {
      return res.status(400).json({ success: false, message: 'Invalid discovery mode' });
    }

    return res.status(200).json({ success: true, rooms: discoveredRooms });

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

    // Ensure user is not blocked by host, though a full check against all members could be done
    if (user.blockedUsers && user.blockedUsers.includes(room.createdBy)) {
      return res.status(403).json({ success: false, message: 'Cannot join this room due to block list.' });
    }

    const existingMember = await RoomMember.findOne({ roomId, userId });
    if (existingMember && existingMember.status === 'JOINED') {
      return res.status(400).json({ success: false, message: 'Already a member of this room' });
    }

    const currentMemberCount = await RoomMember.countDocuments({ roomId, status: 'JOINED' });
    if (currentMemberCount >= room.capacity) {
      room.status = 'FULL';
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
    if (newMemberCount >= room.capacity) {
      room.status = 'FULL';
      await room.save();
      logRoomEvent('ROOM_BECAME_FULL', { roomId });
    } else if (room.status === 'SUGGESTED' && newMemberCount >= 2) {
      room.status = 'ACTIVE';
      await room.save();
      logRoomEvent('ROOM_BECAME_ACTIVE', { roomId });
    }

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

    // Clear socket presence proactively
    if (redisService.del) {
      await redisService.del(`presence:room:${roomId}:${userId}`);
    }

    const newMemberCount = await RoomMember.countDocuments({ roomId, status: 'JOINED' });
    if (room.status === 'FULL' && newMemberCount < room.capacity) {
      room.status = 'ACTIVE';
      await room.save();
      logRoomEvent('ROOM_REOPENED_FROM_FULL', { roomId });
    }

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
    const memberships = await RoomMember.find({ userId, status: 'JOINED' }).select('roomId');
    const roomIds = memberships.map(m => m.roomId);
    const rooms = await HumrahRoom.find({ _id: { $in: roomIds } }).sort({ createdAt: -1 });

    const formattedRooms = await Promise.all(rooms.map(async (room) => {
      const memberCount = await RoomMember.countDocuments({ roomId: room._id, status: 'JOINED' });
      return {
        roomId: room._id,
        title: room.title,
        description: room.description,
        topic: room.topic,
        languages: room.languages,
        discoveryMode: room.discoveryMode,
        capacity: room.capacity,
        memberCount: memberCount,
        status: room.status,
        distanceTier: null,
        createdAt: room.createdAt
      };
    }));

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
    // R1 Note: Currently restricts to joined members. Keeping this.
    const member = await RoomMember.findOne({ roomId, userId, status: 'JOINED' });
    if (!member) return res.status(403).json({ success: false, message: 'Not a member' });

    const room = await HumrahRoom.findById(roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Not found' });
    
    const members = await RoomMember.find({ roomId, status: 'JOINED' }).populate('userId', 'firstName lastName profilePhotoUrls');
    
    // Map _id to roomId
    const roomFormatted = {
      roomId: room._id,
      title: room.title,
      description: room.description,
      topic: room.topic,
      languages: room.languages,
      discoveryMode: room.discoveryMode,
      capacity: room.capacity,
      status: room.status,
      memberCount: members.length,
      createdAt: room.createdAt,
      createdBy: room.createdBy
    };

    res.status(200).json({ success: true, room: roomFormatted, members });
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
      senderName: msg.senderId ? `${msg.senderId.firstName} ${msg.senderId.lastName}`.trim() : 'Unknown',
      messageType: msg.messageType,
      content: msg.content,
      createdAt: msg.createdAt
    }));

    res.status(200).json({ success: true, messages: formattedMessages });
  } catch (error) {
    console.error('[getRoomMessages error]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
