const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const Notification = require('../models/Notification');
const redisService = require('./redisService');
const { sendDataFcm } = require('../utils/fcmHelper');

const COOLDOWN_HOURS = parseInt(process.env.ROOM_INVITATION_COOLDOWN_HOURS || '12', 10);
const COOLDOWN_SECONDS = COOLDOWN_HOURS * 3600;
const DEDUP_SECONDS = 2 * 3600; // 2 hours matching the SUGGESTED lifecycle

async function processRoomInvitations() {
  const lockKey = 'lock:room_invitation_worker';
  const lockAcquired = await redisService.acquireLock(lockKey, 30);
  if (!lockAcquired) {
    return;
  }

  try {
    // 1. Find all active SUGGESTED SYSTEM rooms created in the last 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const suggestedRooms = await HumrahRoom.find({
      creationSource: 'SYSTEM',
      status: 'SUGGESTED',
      createdAt: { $gte: twoHoursAgo }
    });

    if (suggestedRooms.length === 0) {
      return;
    }

    for (const room of suggestedRooms) {
      // 2. Find all INVITED members for this room
      const members = await RoomMember.find({
        roomId: room._id,
        status: 'INVITED' // We only invite people who haven't joined yet
      });

      if (members.length === 0) continue;

      for (const member of members) {
        const userId = member.userId;

        try {
          // 3. Deduplication (don't send twice for same room/user)
          const dedupKey = `room_invitation_sent:${room._id}:${userId}`;
          const alreadySent = await redisService.get(dedupKey);
          if (alreadySent) {
            continue;
          }

          // 4. Cooldown (don't spam the user across multiple rooms)
          const cooldownKey = `cooldown:room_invite:user:${userId}`;
          const onCooldown = await redisService.get(cooldownKey);
          if (onCooldown) {
            console.log(`[R3.3] Skipped user ${userId} - on cooldown`);
            continue;
          }

          // 5. Fetch User to verify capabilities, tokens, and preferences
          const user = await User.findById(userId).select('pushNotifications fcmDevices blockedUsers status');
          
          if (!user || user.status !== 'ACTIVE') {
            console.log(`[R3.3] Skipped user ${userId} - not active`);
            continue;
          }

          if (user.pushNotifications === false) {
            console.log(`[R3.3] Skipped user ${userId} - push disabled`);
            continue;
          }

          // Filter supported devices with tokens
          const supportedTokens = (user.fcmDevices || [])
            .filter(d => d.supportsHumrahRooms === true && d.token)
            .map(d => d.token);

          if (supportedTokens.length === 0) {
            console.log(`[R3.3] Skipped user ${userId} - no capable devices`);
            continue;
          }

          // 6. Double-check room state hasn't changed (e.g. became CLOSED/FULL)
          const currentRoom = await HumrahRoom.findById(room._id).select('status');
          if (!currentRoom || currentRoom.status === 'CLOSED' || currentRoom.status === 'FULL') {
            console.log(`[R3.3] Skipped room ${room._id} - state changed to ${currentRoom?.status}`);
            break; // Stop processing this room for all remaining members
          }

          // 7. Create Notification record
          const topicName = room.topic || 'a topic you love';
          const title = 'A Humrah Room is waiting \uD83D\uDC40'; // 👀
          const message = `A few people are getting together around ${topicName}. Come join the conversation.`;

          const notification = new Notification({
            userId,
            title,
            message,
            type: 'ROOM_INVITATION',
            createdBy: 'system'
          });
          await notification.save();

          // 8. Send via FCM Helper
          const payload = {
            type: 'ROOM_INVITATION',
            roomId: room._id.toString(),
            notificationId: notification._id.toString()
          };

          await sendDataFcm(userId.toString(), supportedTokens, payload);
          console.log(`[R3.3] Sent invitation to user ${userId} for room ${room._id}`);

          // Mark notification as delivered (simplified)
          notification.deliveredAt = new Date();
          await notification.save();

          // 9. Set Deduplication and Cooldown
          await redisService.set(dedupKey, '1', DEDUP_SECONDS);
          await redisService.set(cooldownKey, '1', COOLDOWN_SECONDS);

        } catch (memberErr) {
          console.error(`[R3.3] Error processing user ${member.userId}:`, memberErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[R3.3] Worker error:', err.message);
  } finally {
    await redisService.releaseLock(lockKey);
  }
}

module.exports = {
  processRoomInvitations
};
