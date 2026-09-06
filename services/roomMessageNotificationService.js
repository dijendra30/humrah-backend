// services/roomMessageNotificationService.js
// -----------------------------------------------------------------------------
// Phase 2.1: push notifications for JOINED Room members who are AWAY when a new
// message is persisted.
//
//   persisted RoomMessage → JOINED members (minus sender)
//                         → minus anyone currently inside the Room (presence)
//                         → eligibility (active, not suspended, not blocked,
//                           push enabled, Room-capable device)
//                         → per-Room/user throttle
//                         → ONE Notification record + one multicast FCM send
//
// Completely separate from the Room INVITATION worker: different type, different
// Redis keys, different copy. Nothing here changes Room state, membership,
// capacity or read state.
// -----------------------------------------------------------------------------
'use strict';

const RoomMember = require('../models/RoomMember');
const RoomMessage = require('../models/RoomMessage');
const User = require('../models/User');
const Notification = require('../models/Notification');
const redisService = require('./redisService');
const { getUsersInsideRoom } = require('./roomPresenceService');
const { sendDataFcm } = require('../utils/fcmHelper');

const COOLDOWN_MINUTES = (() => {
  const n = parseInt(process.env.ROOM_MESSAGE_NOTIFICATION_COOLDOWN_MINUTES, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
const COOLDOWN_SECONDS = COOLDOWN_MINUTES * 60;

const cooldownKeyFor = (roomId, userId) => `room_message_notification_cooldown:${roomId}:${userId}`;
const pendingKeyFor = (roomId, userId) => `room_message_pending:${roomId}:${userId}`;

/**
 * Deterministic copy. No AI, ever.
 *
 * Single new message  → "New message in <Topic>" / "<Sender>: <text>"
 * Grouped (throttled) → "New messages in <Topic>" / "<n> new messages in your Humrah Room"
 */
function buildMessageCopy({ topic, senderName, content, pendingCount }) {
  const where = topic && String(topic).trim() ? String(topic).trim() : 'your Humrah Room';

  if (pendingCount > 1) {
    return {
      title: `New messages in ${where}`,
      body: `${pendingCount} new messages in your Humrah Room`,
    };
  }

  const name = senderName && senderName.trim() ? senderName.trim() : 'Someone';
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const preview = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  return {
    title: `New message in ${where}`,
    body: preview ? `${name}: ${preview}` : `${name} sent a message`,
  };
}

/** True when either user has blocked the other. */
function isBlockedPair(a, b) {
  if (!a || !b) return false;
  return (a.blockedUsers || []).some(id => String(id) === String(b._id))
      || (b.blockedUsers || []).some(id => String(id) === String(a._id));
}

/**
 * Notify away members about a message that is ALREADY persisted.
 * Always resolves — a notification failure must never affect chat.
 *
 * @param {object} io           Socket.IO server (for live Room presence)
 * @param {object} params
 * @param {string} params.roomId
 * @param {string} params.messageId    persisted RoomMessage _id
 * @param {string} params.senderId
 * @param {string} params.senderName
 * @param {string} params.content
 * @param {string} params.topic        Room topic (for copy)
 * @returns {Promise<Object>} structured summary
 */
async function notifyAwayRoomMembers(io, params) {
  const { roomId, messageId, senderId, senderName, content, topic } = params || {};
  const summary = {
    event: 'room_message_notification',
    roomId: roomId ? String(roomId) : null,
    recipientsConsidered: 0,
    recipientsInside: 0,
    recipientsThrottled: 0,
    notificationsSent: 0,
    notificationsSkipped: 0,
    fcmsFailed: 0,
    invalidTokensRemoved: 0,
    skipReasons: {},
    durationMs: 0,
  };
  const started = Date.now();
  const skip = (reason) => {
    summary.notificationsSkipped++;
    summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
  };

  try {
    if (!roomId || !messageId) return summary;

    // 1. JOINED members, excluding the sender. INVITED / LEFT / KICKED excluded by query.
    const members = await RoomMember.find({
      roomId,
      status: 'JOINED',
      userId: { $ne: senderId },
    }).select('userId').lean();

    if (members.length === 0) {
      summary.durationMs = Date.now() - started;
      return summary;
    }
    const candidateIds = members.map(m => String(m.userId));
    summary.recipientsConsidered = candidateIds.length;

    // 2. Who is currently inside the Room → socket delivery already covered them.
    const inside = await getUsersInsideRoom(io, roomId, candidateIds);
    const awayIds = candidateIds.filter(id => !inside.has(id));
    summary.recipientsInside = candidateIds.length - awayIds.length;
    if (awayIds.length === 0) {
      summary.durationMs = Date.now() - started;
      return summary;
    }

    // 3. ONE user query for every away candidate + the sender (for the block check).
    const users = await User.find({ _id: { $in: [...awayIds, String(senderId)] } })
      .select('_id status suspensionInfo pushNotifications fcmDevices blockedUsers')
      .lean();
    const userById = new Map(users.map(u => [String(u._id), u]));
    const sender = userById.get(String(senderId));

    for (const uid of awayIds) {
      try {
        const user = userById.get(uid);
        if (!user) { skip('user_missing'); continue; }
        if (user.status !== 'ACTIVE') { skip('user_not_active'); continue; }
        if (user.suspensionInfo?.isSuspended === true) { skip('user_suspended'); continue; }
        if (user.pushNotifications === false) { skip('push_disabled'); continue; }
        if (isBlockedPair(user, sender)) { skip('blocked_pair'); continue; }

        const tokens = [...new Set(
          (user.fcmDevices || [])
            .filter(d => d.supportsHumrahRooms === true && typeof d.token === 'string' && d.token.trim())
            .map(d => d.token)
        )];
        if (tokens.length === 0) { skip('no_capable_device'); continue; }

        // 4. Per-Room/user throttle. During cooldown we only increment a pending
        //    counter — one grouped notification is sent once the window expires.
        const cdKey = cooldownKeyFor(roomId, uid);
        const onCooldown = await redisService.get(cdKey);
        if (onCooldown) {
          summary.recipientsThrottled++;
          // Pending counter outlives the cooldown slightly so the grouped send can read it.
          await redisService.incrementWithWindow(pendingKeyFor(roomId, uid), COOLDOWN_SECONDS * 2);
          continue;
        }

        // Messages accumulated while this user was throttled (the previous window).
        const pendingRaw = await redisService.get(pendingKeyFor(roomId, uid));
        const pendingCount = (typeof pendingRaw === 'number' ? pendingRaw : 0) + 1;

        const { title, body } = buildMessageCopy({ topic, senderName, content, pendingCount });

        const notification = await new Notification({
          userId: uid,
          title,
          message: body,
          type: 'ROOM_MESSAGE',
          createdBy: 'system',
          roomId,
          messageId,
        }).save();

        const fcm = await sendDataFcm(uid, tokens, {
          type: 'ROOM_MESSAGE',
          roomId: String(roomId),
          notificationId: String(notification._id),
          messageId: String(messageId),
          title,
          body,
        });
        summary.invalidTokensRemoved += fcm.invalidTokensRemoved;

        if (!fcm.delivered) {
          summary.fcmsFailed++;
          notification.failureReason = fcm.error || 'fcm_delivery_failed';
          await notification.save();
          skip('fcm_failed');
          continue; // no cooldown burned — a later message can retry
        }

        notification.deliveredAt = new Date();
        await notification.save();

        await redisService.set(cdKey, '1', COOLDOWN_SECONDS);
        await redisService.del(pendingKeyFor(roomId, uid)); // counter consumed
        summary.notificationsSent++;
      } catch (perUserErr) {
        skip('recipient_error');
        console.error('[ROOM_MSG_NOTIF] recipient error:', perUserErr.message);
      }
    }
  } catch (err) {
    summary.error = err.message;
    console.error('[ROOM_MSG_NOTIF] failed:', err.message);
  }

  summary.durationMs = Date.now() - started;
  // Counts and the roomId only — never message text, tokens or profile data.
  if (summary.notificationsSent > 0 || summary.fcmsFailed > 0 || summary.error) {
    console.log('[ROOM_MSG_NOTIF]', JSON.stringify(summary));
  }
  return summary;
}

/**
 * Flushes a grouped notification for messages that accumulated during a cooldown.
 * Invoked opportunistically on the next message after the window expires (the
 * pendingCount path above), so no extra background job is required.
 */
async function getPendingCount(roomId, userId) {
  const v = await redisService.get(pendingKeyFor(roomId, userId));
  return typeof v === 'number' ? v : 0;
}

module.exports = {
  notifyAwayRoomMembers,
  buildMessageCopy,
  isBlockedPair,
  getPendingCount,
  cooldownKeyFor,
  pendingKeyFor,
  COOLDOWN_SECONDS,
  COOLDOWN_MINUTES,
};
