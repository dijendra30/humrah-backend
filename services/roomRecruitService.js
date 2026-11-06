// services/roomRecruitService.js
// -----------------------------------------------------------------------------
// Room supply (6 Nov 2026, approved by the product owner): once someone joins a
// Humrah-hosted Room, tell a FEW people who might like it, so they aren't alone in it.
//
//   1. People who picked the Room's topic as an interest (active in the last 30 days).
//   2. Only when fewer than 3 of those can be told: a "cold" notification to people
//      active in the last 14 days who didn't pick it.
//
// No notification flood (all enforced here, all from the database, so a restart or a
// missing Redis can't reset them):
//   - per person: at most 1 Room push ("come join") a day and 3 a week, counting the
//     existing ROOM_INVITATION pushes too; never twice about the same Room in 30 days;
//   - per Room: at most 10 interest and 5 cold notifications a day;
//   - per run: at most 40 sends; nothing between 22:00 and 08:00 IST;
//   - only while the Room has 1-4 people and someone joined in the last 6 hours;
//   - respects the push switch, suspensions, blocks (both ways, against everyone in
//     the Room) and only reaches app builds that can open the Room (supportsRoomRecruit).
//
// The copy states only real, current facts (the joined count at send time). It never
// names who is in the Room.
//
// Gated by ROOM_RECRUIT_ENABLED (default false).
// -----------------------------------------------------------------------------
'use strict';

const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const User = require('../models/User');
const Notification = require('../models/Notification');
const redisService = require('./redisService');
const { sendDataFcm } = require('../utils/fcmHelper');
const { canonicalizeTopic } = require('../utils/roomTopicConfig');
const { CREATION_SOURCE_CURATED } = require('../utils/curatedRoomConfig');
const { cooldownKeyFor: inviteCooldownKeyFor, COOLDOWN_SECONDS: INVITE_COOLDOWN_SECONDS } = require('./roomInvitationService');

const DAY = 86400000;

const RECRUIT_CONFIG = Object.freeze({
  RECRUIT_UNTIL_MEMBERS: 5,          // stop once 5 people have joined
  JOIN_WINDOW_HOURS: 6,              // only after a recent join
  INTEREST_PER_ROOM_PER_DAY: 10,
  COLD_PER_ROOM_PER_DAY: 5,
  COLD_ONLY_BELOW_INTEREST: 3,       // cold only if fewer interested people could be told
  USER_MAX_PER_DAY: 1,
  USER_MAX_PER_WEEK: 3,
  SAME_ROOM_DAYS: 30,
  INTEREST_ACTIVE_DAYS: 30,
  COLD_ACTIVE_DAYS: 14,
  MAX_SENDS_PER_RUN: 40,
  CANDIDATE_POOL: 200,
  QUIET_START_HOUR_IST: 22,
  QUIET_END_HOUR_IST: 8,
});

// Room pushes that count toward a person's daily/weekly limit.
const CAPPED_TYPES = ['ROOM_RECRUIT', 'ROOM_INVITATION'];

/** Hour of day in India (UTC+5:30). */
function istHour(now) {
  return Math.floor(((now.getTime() + 5.5 * 3600000) % DAY) / 3600000);
}

function isQuietHours(now) {
  const h = istHour(now);
  return h >= RECRUIT_CONFIG.QUIET_START_HOUR_IST || h < RECRUIT_CONFIG.QUIET_END_HOUR_IST;
}

/** Plain, fixed copy. Only the real joined count, never who. */
function buildRecruitCopy(roomTitle, joinedCount, audience) {
  const name = String(roomTitle || 'Humrah').trim();
  const title = joinedCount === 1
    ? `Someone joined the ${name} Room`
    : `${joinedCount} people are in the ${name} Room`;
  const body = audience === 'INTEREST'
    ? `${name} is one of your interests, so we thought you'd like to know. Join them?`
    : "It's open to anyone on Humrah. Drop in if you feel like chatting.";
  return { title, body };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function capableTokens(user) {
  return [...new Set((user.fcmDevices || [])
    .filter(d => d && d.supportsRoomRecruit === true && typeof d.token === 'string' && d.token.trim())
    .map(d => d.token))];
}

function hasInterest(user, topic) {
  return (user.questionnaire?.humrahRoomInterests || []).some(i => canonicalizeTopic(i) === topic);
}

/** Rooms that should recruit right now, with their JOINED members. */
async function loadRecruitingRooms(now) {
  const rooms = await HumrahRoom.find({
    creationSource: CREATION_SOURCE_CURATED,
    status: 'ACTIVE',
    discoveryMode: 'ALL_INDIA',
    standby: { $ne: true },
    memberCount: { $gte: 1, $lt: RECRUIT_CONFIG.RECRUIT_UNTIL_MEMBERS },
  }).select('title topic capacity').limit(100).lean();
  if (rooms.length === 0) return [];

  const members = await RoomMember.find({ roomId: { $in: rooms.map(r => r._id) } })
    .select('roomId userId status joinedAt').lean();
  const since = now.getTime() - RECRUIT_CONFIG.JOIN_WINDOW_HOURS * 3600000;

  const out = [];
  for (const room of rooms) {
    const mine = members.filter(m => String(m.roomId) === String(room._id));
    const joined = mine.filter(m => m.status === 'JOINED');
    if (joined.length < 1 || joined.length >= RECRUIT_CONFIG.RECRUIT_UNTIL_MEMBERS) continue;
    const lastJoin = Math.max(...joined.map(m => new Date(m.joinedAt || 0).getTime()));
    if (lastJoin < since) continue;
    out.push({
      room,
      topic: canonicalizeTopic(room.topic) || room.topic,
      joinedIds: joined.map(m => String(m.userId)),
      anyMembershipIds: new Set(mine.map(m => String(m.userId))),
    });
  }
  return out;
}

/** userId -> { day, week } delivered capped Room pushes. One query for all ids. */
async function loadUserPushCounts(userIds, now) {
  if (userIds.length === 0) return new Map();
  const rows = await Notification.aggregate([
    { $match: { userId: { $in: userIds }, type: { $in: CAPPED_TYPES }, deliveredAt: { $ne: null }, createdAt: { $gte: new Date(now - 7 * DAY) } } },
    { $group: { _id: '$userId', week: { $sum: 1 }, day: { $sum: { $cond: [{ $gte: ['$createdAt', new Date(now - DAY)] }, 1, 0] } } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r]));
}

/** Who may be told about this Room, best first, before the per-person caps. */
async function loadCandidates(target, audience, now) {
  const days = audience === 'INTEREST' ? RECRUIT_CONFIG.INTEREST_ACTIVE_DAYS : RECRUIT_CONFIG.COLD_ACTIVE_DAYS;
  const query = {
    _id: { $nin: [...target.anyMembershipIds] },
    status: 'ACTIVE',
    'suspensionInfo.isSuspended': { $ne: true },
    pushNotifications: { $ne: false },
    'notifications.pushNotifications': { $ne: false },
    lastActive: { $gte: new Date(now - days * DAY) },
    fcmDevices: { $elemMatch: { supportsRoomRecruit: true } },
  };
  const topicRe = new RegExp('^\\s*' + escapeRegex(target.topic) + '\\s*$', 'i');
  if (audience === 'INTEREST') {
    query['questionnaire.humrahRoomInterests'] = topicRe;
  } else {
    query['questionnaire.humrahRoomInterests'] = { $not: topicRe };
    query['notifications.promotions'] = { $ne: false };
  }
  const users = await User.find(query)
    .select('_id fcmDevices blockedUsers questionnaire.humrahRoomInterests lastActive')
    .sort({ lastActive: -1 })
    .limit(RECRUIT_CONFIG.CANDIDATE_POOL)
    .lean();
  // Exact topic check after the case-insensitive query.
  return users.filter(u => (audience === 'INTEREST') === hasInterest(u, target.topic));
}

async function processRoomRecruitment({ now = new Date(), force = false } = {}) {
  const summary = {
    event: 'room_recruit', roomsConsidered: 0, sent: 0, sentInterest: 0, sentCold: 0,
    fcmFailed: 0, skipped: {}, quietHours: false, failed: false,
  };
  const skip = (r, n = 1) => { summary.skipped[r] = (summary.skipped[r] || 0) + n; };

  if (isQuietHours(now) && !force) {
    summary.quietHours = true;
    return summary;
  }

  try {
    const targets = await loadRecruitingRooms(now);
    summary.roomsConsidered = targets.length;
    const toldThisRun = new Set();

    for (const target of targets) {
      if (summary.sent >= RECRUIT_CONFIG.MAX_SENDS_PER_RUN) break;
      const roomId = target.room._id;

      // Per-Room daily caps, by audience.
      const roomRows = await Notification.aggregate([
        { $match: { roomId, type: 'ROOM_RECRUIT', deliveredAt: { $ne: null }, createdAt: { $gte: new Date(now - DAY) } } },
        { $group: { _id: '$audience', n: { $sum: 1 } } },
      ]);
      const roomSent = Object.fromEntries(roomRows.map(r => [r._id, r.n]));
      const left = {
        INTEREST: RECRUIT_CONFIG.INTEREST_PER_ROOM_PER_DAY - (roomSent.INTEREST || 0),
        COLD: RECRUIT_CONFIG.COLD_PER_ROOM_PER_DAY - (roomSent.COLD || 0),
      };

      // Blocks are checked against everyone currently in the Room, both directions.
      const inRoom = await User.find({ _id: { $in: target.joinedIds } }).select('_id blockedUsers').lean();
      const inRoomIds = new Set(target.joinedIds);
      const blockedByRoom = new Set();
      inRoom.forEach(u => (u.blockedUsers || []).forEach(b => blockedByRoom.add(String(b))));

      // Never twice about the same Room within SAME_ROOM_DAYS (any outcome but failure).
      const alreadyTold = new Set((await Notification.find({
        roomId, type: 'ROOM_RECRUIT', deliveredAt: { $ne: null }, createdAt: { $gte: new Date(now - RECRUIT_CONFIG.SAME_ROOM_DAYS * DAY) },
      }).select('userId').lean()).map(n => String(n.userId)));

      const eligible = async (users) => {
        const counts = await loadUserPushCounts(users.map(u => u._id), now);
        const ok = [];
        for (const u of users) {
          const id = String(u._id);
          if (toldThisRun.has(id)) { skip('told_this_run'); continue; }
          if (alreadyTold.has(id)) { skip('same_room'); continue; }
          if (blockedByRoom.has(id) || (u.blockedUsers || []).some(b => inRoomIds.has(String(b)))) { skip('blocked'); continue; }
          const c = counts.get(id);
          if (c && (c.day >= RECRUIT_CONFIG.USER_MAX_PER_DAY || c.week >= RECRUIT_CONFIG.USER_MAX_PER_WEEK)) { skip('user_cap'); continue; }
          if (await redisService.get(inviteCooldownKeyFor(id))) { skip('invite_cooldown'); continue; }
          if (capableTokens(u).length === 0) { skip('no_capable_device'); continue; }
          ok.push(u);
        }
        return ok;
      };

      const interested = left.INTEREST > 0 ? await eligible(await loadCandidates(target, 'INTEREST', now)) : [];
      const plan = interested.slice(0, Math.max(0, left.INTEREST)).map(u => ({ u, audience: 'INTEREST' }));
      // Cold only when the interested people (already told today + those who can be told
      // now) are fewer than 3. A Room that used its interest quota today gets no cold ones.
      const interestReach = (roomSent.INTEREST || 0) + plan.length;
      if (interestReach < RECRUIT_CONFIG.COLD_ONLY_BELOW_INTEREST && left.COLD > 0) {
        const cold = await eligible(await loadCandidates(target, 'COLD', now));
        cold.slice(0, left.COLD).forEach(u => plan.push({ u, audience: 'COLD' }));
      }

      // Re-read the Room right before sending: it may have filled, emptied or been put away.
      const fresh = await HumrahRoom.findById(roomId).select('status standby memberCount title').lean();
      if (!fresh || fresh.status !== 'ACTIVE' || fresh.standby === true
          || !(fresh.memberCount >= 1 && fresh.memberCount < RECRUIT_CONFIG.RECRUIT_UNTIL_MEMBERS)) {
        skip('room_changed');
        continue;
      }

      for (const { u, audience } of plan) {
        if (summary.sent >= RECRUIT_CONFIG.MAX_SENDS_PER_RUN) break;
        const userId = String(u._id);
        const { title, body } = buildRecruitCopy(fresh.title, fresh.memberCount, audience);
        const notification = await new Notification({
          userId, title, message: body, type: 'ROOM_RECRUIT', roomId, audience, createdBy: 'system',
        }).save();
        const fcm = await sendDataFcm(userId, capableTokens(u), {
          type: 'ROOM_RECRUIT',
          roomId: String(roomId),
          notificationId: String(notification._id),
          topic: target.topic,
          title,
          body,
        }, { quietLog: true });
        toldThisRun.add(userId);
        if (!fcm.delivered) {
          // A failed send burns nothing: no cap, no cooldown, no same-Room mark.
          notification.failureReason = fcm.error || 'fcm_delivery_failed';
          await notification.save();
          summary.fcmFailed++;
          continue;
        }
        notification.deliveredAt = new Date();
        await notification.save();
        // Also holds back the system invitation worker for this person.
        await redisService.set(inviteCooldownKeyFor(userId), '1', INVITE_COOLDOWN_SECONDS);
        summary.sent++;
        if (audience === 'INTEREST') summary.sentInterest++; else summary.sentCold++;
      }
    }
  } catch (err) {
    summary.failed = true;
    summary.error = err.message;
  }
  // Counts and reasons only: no user ids, no tokens.
  if (summary.roomsConsidered > 0 || summary.failed) console.log('[RoomRecruit]', JSON.stringify(summary));
  return summary;
}

module.exports = {
  RECRUIT_CONFIG,
  CAPPED_TYPES,
  istHour,
  isQuietHours,
  buildRecruitCopy,
  loadRecruitingRooms,
  processRoomRecruitment,
};
