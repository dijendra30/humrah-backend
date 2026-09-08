// services/roomInvitationService.js
// -----------------------------------------------------------------------------
// PHASE 2: Humrah Room invitation worker.
//
//   SYSTEM + SUGGESTED Room  →  INVITED RoomMembers  →  eligibility  →  FCM
//   →  Notification history  →  Android notification  →  user EXPLICITLY joins
//
// The worker never joins anyone, never changes Room state, never changes capacity
// and never touches membership. It only decides who may be told about a Room.
//
// Distributed safety: one Redis worker lock, per-room/user dedup, per-user cooldown.
// A failed FCM send leaves the user INVITED and does NOT burn their cooldown.
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const Notification = require('../models/Notification');
const redisService = require('./redisService');
const { sendDataFcm } = require('../utils/fcmHelper');

const { suggestedCutoff, suggestedLifetimeSeconds } = require('./roomLifecycleConfig');

const COOLDOWN_HOURS = parseInt(process.env.ROOM_INVITATION_COOLDOWN_HOURS || '12', 10);
const COOLDOWN_SECONDS = COOLDOWN_HOURS * 3600;
// Dedup must last exactly as long as the Room it refers to, so a user is told
// about a given Room once and only once for its whole life. Read from the shared
// lifecycle config (was a hard-coded 2h that had to be kept in sync by hand).
const dedupSeconds = () => suggestedLifetimeSeconds();

const LOCK_KEY = 'lock:room_invitation_worker';
const dedupKeyFor = (roomId, userId) => `room_invitation_sent:${roomId}:${userId}`;
const cooldownKeyFor = (userId) => `cooldown:room_invite:user:${userId}`;

/**
 * Deterministic, non-AI invitation copy. Never implies analysis or surveillance.
 */
function buildInvitationCopy(topic) {
  const t = (topic && String(topic).trim()) || null;
  return {
    title: 'A Humrah Room is waiting 👀', // 👀
    body: t
      ? `A few people are getting together around ${t}. Come join the conversation.`
      : 'A few people are getting together. Come join the conversation.',
  };
}

/** True when either user has blocked the other. */
function isBlockedPair(a, b) {
  if (!a || !b) return false;
  const aBlocks = (a.blockedUsers || []).some(id => String(id) === String(b._id));
  const bBlocks = (b.blockedUsers || []).some(id => String(id) === String(a._id));
  return aBlocks || bBlocks;
}

async function processRoomInvitations() {
  const summary = {
    event: 'room_invitation_worker',
    startedAt: new Date().toISOString(),
    roomsScanned: 0,
    invitationsConsidered: 0,
    notificationsSent: 0,
    notificationsSkipped: 0,
    duplicateSkipped: 0,
    cooldownSkipped: 0,
    invalidTokensRemoved: 0,
    fcmsFailed: 0,
    roomsSkippedStale: 0,
    skipReasons: {},
    durationMs: 0,
    lock: 'acquired',
  };
  const started = Date.now();
  const skip = (reason) => {
    summary.notificationsSkipped++;
    summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
  };

  let lockAcquired = false;
  try {
    lockAcquired = await redisService.acquireLock(LOCK_KEY, 30);
  } catch (err) {
    summary.lock = 'error';
    summary.durationMs = Date.now() - started;
    console.error('[RoomInvite] Lock acquisition failed:', err.message);
    return summary;
  }
  if (!lockAcquired) {
    summary.lock = 'rejected';
    summary.durationMs = Date.now() - started;
    return summary; // another instance is already running — correct, not an error
  }

  try {
    // 1. SYSTEM + SUGGESTED Rooms still inside the invitation window. The window
    //    is the Room's own lifetime, shared with the expiry job — a Room that is
    //    still open must still be invitable, or it sits visible but unreachable.
    const suggestedRooms = await HumrahRoom.find({
      creationSource: 'SYSTEM',
      status: 'SUGGESTED',
      createdAt: { $gte: suggestedCutoff() },
    });
    summary.roomsScanned = suggestedRooms.length;

    for (const room of suggestedRooms) {
      const roomId = String(room._id);

      // 2. Everyone attached to this Room (INVITED to notify, JOINED for block checks).
      const allMembers = await RoomMember.find({
        roomId: room._id,
        status: { $in: ['INVITED', 'JOINED'] },
      }).select('userId status');

      const invited = allMembers.filter(m => m.status === 'INVITED');
      if (invited.length === 0) continue;

      // 3. ONE user query per Room — serves eligibility AND the block matrix.
      const memberUserIds = allMembers.map(m => m.userId);
      const users = await User.find({ _id: { $in: memberUserIds } })
        .select('_id status suspensionInfo pushNotifications fcmDevices blockedUsers');
      const userById = new Map(users.map(u => [String(u._id), u]));
      const counterparts = allMembers.map(m => userById.get(String(m.userId))).filter(Boolean);

      for (const member of invited) {
        const userId = String(member.userId);
        summary.invitationsConsidered++;

        try {
          // 4. Per-room/user dedup — never send the same Room invitation twice.
          if (await redisService.get(dedupKeyFor(roomId, userId))) {
            summary.duplicateSkipped++;
            continue;
          }

          // 5. Per-user cooldown — don't spam across Rooms.
          if (await redisService.get(cooldownKeyFor(userId))) {
            summary.cooldownSkipped++;
            continue;
          }

          const user = userById.get(userId);
          if (!user) { skip('user_missing'); continue; }
          if (user.status !== 'ACTIVE') { skip('user_not_active'); continue; }
          if (user.suspensionInfo?.isSuspended === true) { skip('user_suspended'); continue; }
          if (user.pushNotifications === false) { skip('push_disabled'); continue; }

          // 6. Block relationships against every other participant, both directions.
          const blocked = counterparts.some(
            other => String(other._id) !== userId && isBlockedPair(user, other)
          );
          if (blocked) { skip('blocked_pair'); continue; }

          // 7. Room-capable devices only. supportsHumrahRooms is an explicit boolean;
          //    devices from older clients default to false and are never targeted.
          const supportedTokens = [...new Set(
            (user.fcmDevices || [])
              .filter(d => d.supportsHumrahRooms === true && typeof d.token === 'string' && d.token.trim())
              .map(d => d.token)
          )];
          if (supportedTokens.length === 0) { skip('no_capable_device'); continue; }

          // 8. Re-check Room state immediately before sending (it may have filled,
          //    activated or closed since the scan).
          const currentRoom = await HumrahRoom.findById(room._id).select('status topic');
          if (!currentRoom) { summary.roomsSkippedStale++; skip('room_missing'); break; }
          if (['CLOSED', 'INACTIVE'].includes(currentRoom.status)) {
            summary.roomsSkippedStale++; skip('room_closed'); break;
          }
          if (currentRoom.status === 'FULL') {
            summary.roomsSkippedStale++; skip('room_full'); break;
          }

          // 9. Notification history — ONE record per invitation event, not per device.
          const { title, body } = buildInvitationCopy(currentRoom.topic);
          const notification = await new Notification({
            userId,
            title,
            message: body,
            type: 'ROOM_INVITATION',
            createdBy: 'system',
          }).save();

          // 10. Deliver. Payload carries no personal data and no coordinates.
          const fcm = await sendDataFcm(userId, supportedTokens, {
            type: 'ROOM_INVITATION',
            roomId,
            notificationId: String(notification._id),
            topic: currentRoom.topic || '',
            title,
            body,
          });

          summary.invalidTokensRemoved += fcm.invalidTokensRemoved;

          if (!fcm.delivered) {
            // PHASE 2: a failed send must NOT consume the user's 12h cooldown and
            // must NOT be recorded as delivered. The user stays INVITED and can
            // still be retried on the next run (or join via normal Room flows).
            summary.fcmsFailed++;
            notification.failureReason = fcm.error || 'fcm_delivery_failed';
            await notification.save();
            skip('fcm_failed');
            continue;
          }

          notification.deliveredAt = new Date();
          await notification.save();

          // 11. Only now burn dedup + cooldown.
          await redisService.set(dedupKeyFor(roomId, userId), '1', dedupSeconds());
          await redisService.set(cooldownKeyFor(userId), '1', COOLDOWN_SECONDS);
          summary.notificationsSent++;
        } catch (memberErr) {
          // One bad member never aborts the Room or the worker.
          skip('member_error');
          console.error('[RoomInvite] member processing error:', memberErr.message);
        }
      }
    }
  } catch (err) {
    summary.error = err.message;
    console.error('[RoomInvite] Worker error:', err.message);
  } finally {
    if (lockAcquired) {
      try {
        await redisService.releaseLock(LOCK_KEY);
      } catch (releaseErr) {
        console.error('[RoomInvite] Lock release failed (TTL will expire it):', releaseErr.message);
      }
    }
  }

  summary.durationMs = Date.now() - started;
  // Counts and reason categories only — no user ids, tokens, or profile data.
  if (summary.roomsScanned > 0 || summary.lock !== 'acquired') {
    console.log('[RoomInvite]', JSON.stringify(summary));
  }
  return summary;
}

module.exports = {
  processRoomInvitations,
  buildInvitationCopy,
  isBlockedPair,
  LOCK_KEY,
  dedupKeyFor,
  cooldownKeyFor,
  COOLDOWN_SECONDS,
  // Kept as an export for callers/tests that read it, but it is now DERIVED from
  // roomLifecycleConfig rather than a standalone constant.
  dedupSeconds,
};
