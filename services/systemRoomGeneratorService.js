// services/systemRoomGeneratorService.js
'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const redisService = require('../services/redisService');
const { calculatePairwiseCompatibility, checkEligibility, normalizeMatchingProfile } = require('./roomMatchingService');
const { isValidTopicForUser, resolveRoomTopicImage, canonicalizeTopics } = require('../utils/roomTopicConfig');

// --- THRESHOLDS & CONFIG ---
const CONFIG = {
  MIN_GROUP_SIZE: 2,
  MAX_GROUP_SIZE: 5,
  MIN_PAIRWISE_SCORE: 60,       // Every pair must be at least somewhat compatible
  MIN_COHESION_SCORE: 70,       // The overall group average must be strong
  MIN_EVIDENCE_CONFIDENCE: 2,   // Minimum number of distinct matched signals required to trust the score
  MAX_ROOMS_PER_RUN: 20,        // Operational limit to prevent runaway creation
  MAX_CANDIDATES_PER_RUN: 500,  // Scale protection
  LOCK_TTL_SECONDS: 60          // Concurrency protection window
};

/**
 * Calculates group cohesion given a set of users.
 * Generates N*(N-1)/2 pairwise scores.
 * Returns { cohesionScore, minPairwiseScore, avgConfidence, pairwiseDetails, valid }
 */
function calculateGroupCohesion(users) {
  if (users.length < 2) return { valid: false, cohesionScore: 0 };

  const pairwiseScores = [];
  let totalConfidence = 0;
  const pairwiseDetails = [];

  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const result = calculatePairwiseCompatibility(users[i], users[j]);
      if (!result.eligible) {
        return { valid: false, reason: `Ineligible pair: ${users[i]._id}-${users[j]._id}` };
      }
      
      const confidence = result.matchedSignals.length;
      totalConfidence += confidence;
      
      pairwiseScores.push(result.overallScore);
      pairwiseDetails.push({ u1: users[i]._id.toString(), u2: users[j]._id.toString(), score: result.overallScore, confidence });
    }
  }

  const sum = pairwiseScores.reduce((a, b) => a + b, 0);
  const cohesionScore = Math.round(sum / pairwiseScores.length);
  const minPairwiseScore = Math.min(...pairwiseScores);
  const avgConfidence = totalConfidence / pairwiseScores.length;

  return {
    valid: true,
    cohesionScore,
    minPairwiseScore,
    avgConfidence,
    pairwiseDetails
  };
}

/**
 * Deterministically selects the best topic for the group.
 * Priority: 
 * 1. Explicitly shared by all/majority of members in humrahRoomInterests
 * 2. Must be valid for all members based on location rules
 */
function selectRoomTopic(users) {
  // Topic counting is CANONICAL, not literal. The questionnaire (Q24) shipped the
  // same 35 topics in sentence case ("Food & cooking") while this service and the
  // Room creation flow use title case ("Food & Cooking"). Counting raw strings made
  // those two spellings look like two different topics, so `count >= 2` below could
  // never be reached and every group was discarded as `no_viable_topic`.
  // canonicalizeTopic() resolves case/whitespace only — never meaning — and returns
  // null for genuinely unknown topics, which are still ignored.
  const topicCounts = {};
  users.forEach(u => {
    const interests = canonicalizeTopics(u.questionnaire?.humrahRoomInterests);
    // canonicalizeTopics() de-duplicates, so a user holding both "Music" and
    // "music" contributes one vote, not two.
    interests.forEach(topic => {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });
  });

  const candidates = Object.entries(topicCounts)
    .filter(([topic, count]) => {
      // Must be valid for ALL users (e.g. local topics)
      const allValid = users.every(u => isValidTopicForUser(topic, u.questionnaire?.city));
      // Require at least 2 users to explicitly want it (or 100% if size is 2)
      return allValid && count >= 2; 
    })
    .sort((a, b) => {
      // Sort by highest count, then alphabetically to remain deterministic
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });

  if (candidates.length > 0) {
    return { topic: candidates[0][0], supportCount: candidates[0][1] };
  }
  return null;
}

/**
 * Validates a proposed group against all thresholds.
 */
function evaluateGroupViability(users) {
  if (users.length < CONFIG.MIN_GROUP_SIZE || users.length > CONFIG.MAX_GROUP_SIZE) {
    return { viable: false, reason: 'invalid_size' };
  }

  const cohesion = calculateGroupCohesion(users);
  if (!cohesion.valid) {
    return { viable: false, reason: cohesion.reason };
  }

  if (cohesion.minPairwiseScore < CONFIG.MIN_PAIRWISE_SCORE) {
    return { viable: false, reason: `min_pairwise_too_low (${cohesion.minPairwiseScore})` };
  }

  if (cohesion.cohesionScore < CONFIG.MIN_COHESION_SCORE) {
    return { viable: false, reason: `cohesion_too_low (${cohesion.cohesionScore})` };
  }

  if (cohesion.avgConfidence < CONFIG.MIN_EVIDENCE_CONFIDENCE) {
    return { viable: false, reason: `low_confidence (${cohesion.avgConfidence.toFixed(1)})` };
  }

  const topicSelection = selectRoomTopic(users);
  if (!topicSelection) {
    return { viable: false, reason: 'no_viable_topic' };
  }

  return {
    viable: true,
    groupScore: cohesion.cohesionScore, // Using cohesion as the overall group score
    cohesionScore: cohesion.cohesionScore,
    confidence: cohesion.avgConfidence >= 4 ? 'HIGH' : (cohesion.avgConfidence >= 2.5 ? 'MEDIUM' : 'LOW'),
    memberCount: users.length,
    selectedTopic: topicSelection.topic,
    members: users.map(u => u._id.toString()),
    details: cohesion.pairwiseDetails
  };
}

/**
 * Prevents exact duplicate rooms.
 * A duplicate is an ACTIVE or FULL room with the exact same members and topic.
 */
async function checkExistingRoom(memberIds, topic) {
  // Find all ACTIVE/FULL rooms with this topic
  const activeRooms = await HumrahRoom.find({ 
    topic, 
    status: { $in: ['ACTIVE', 'FULL', 'SUGGESTED'] } 
  }).select('_id');

  if (activeRooms.length === 0) return false;
  const roomIds = activeRooms.map(r => r._id);

  // For each room, get the current joined members
  const memberships = await RoomMember.find({
    roomId: { $in: roomIds },
    status: { $in: ['JOINED', 'INVITED'] }
  }).select('roomId userId');

  // Group by roomId
  const roomMembersMap = {};
  memberships.forEach(m => {
    if (!roomMembersMap[m.roomId]) roomMembersMap[m.roomId] = new Set();
    roomMembersMap[m.roomId].add(m.userId.toString());
  });

  const proposedSet = new Set(memberIds);

  for (const [roomId, existingMemberSet] of Object.entries(roomMembersMap)) {
    if (existingMemberSet.size === proposedSet.size) {
      let exactMatch = true;
      for (const id of proposedSet) {
        if (!existingMemberSet.has(id)) {
          exactMatch = false;
          break;
        }
      }
      if (exactMatch) return true; // Found an exact duplicate
    }
  }

  return false;
}

/**
 * Creates a Room in the database with creationSource = 'SYSTEM'.
 */
async function createSystemRoom(groupEval, discoveryMode = 'ALL_INDIA') {
  // Sort member IDs deterministically to create a stable group hash for concurrency lock
  const sortedIds = [...groupEval.members].sort().join(',');
  const lockKey = `lock:system_room:${sortedIds}:${groupEval.selectedTopic}`;

  // Concurrency protection: Try to acquire the per-group Redis lock.
  // PHASE 1 FIX: this previously referenced `redisService.client` (which does not
  // exist — redisService exposes getClient()) and used node-redis v4 option syntax
  // while the project runs ioredis. The guard was therefore always false and the
  // lock was a silent no-op. redisService.acquireLock() is the ioredis-correct
  // SET NX EX helper already used by joinRoom/leaveRoom.
  let acquiredLock = false;
  try {
    acquiredLock = await redisService.acquireLock(lockKey, CONFIG.LOCK_TTL_SECONDS);
    if (!acquiredLock) {
      return { success: false, reason: 'concurrent_generation_lock' };
    }
  } catch (err) {
    console.warn('[SystemRoomGenerator] Redis lock unavailable, falling back to DB duplicate check only:', err.message);
  }

  let room = null;
  try {
    const isDuplicate = await checkExistingRoom(groupEval.members, groupEval.selectedTopic);
    if (isDuplicate) {
      return { success: false, reason: 'duplicate_room_exists' };
    }

    room = new HumrahRoom({
      creationSource: 'SYSTEM',
      discoveryMode,
      // PHASE 1 FIX: HumrahRoom.title has maxlength 30. Canonical topics such as
      // "Creative Writing & Storytelling" (31 chars) previously threw a
      // ValidationError and silently killed generation for that topic.
      title: buildSystemRoomTitle(groupEval.selectedTopic),
      description: `A system-suggested room for ${groupEval.selectedTopic}`,
      topic: groupEval.selectedTopic,
      languages: [], // Let members speak freely, or could intersect languages
      capacity: groupEval.memberCount,
      status: 'SUGGESTED',
    });

    await room.save();

    // Add members
    const memberDocs = groupEval.members.map(userId => ({
      roomId: room._id,
      userId,
      role: 'PARTICIPANT',
      status: 'INVITED'
    }));

    try {
      await RoomMember.insertMany(memberDocs);
    } catch (memberErr) {
      // PHASE 1 FIX: never leave a half-created Room. The HumrahRoom document is
      // already persisted at this point, so compensate by removing it (and any
      // partially inserted memberships) before surfacing the failure.
      console.error('[SystemRoomGenerator] Member insert failed, rolling back room:', memberErr.message);
      try {
        await RoomMember.deleteMany({ roomId: room._id });
        await HumrahRoom.deleteOne({ _id: room._id });
      } catch (rollbackErr) {
        console.error('[SystemRoomGenerator] Rollback failed for room', String(room._id), rollbackErr.message);
      }
      return { success: false, reason: 'member_insert_failed' };
    }

    // Set 24h transient TTL for lifecycle handling
    if (redisService.setWithJitter) {
      await redisService.setWithJitter(`room:transient:${room._id}`, { status: 'SUGGESTED', creationSource: 'SYSTEM' }, 86400, 3600);
    }

    return {
      success: true,
      room: {
        roomId: room._id,
        topic: room.topic,
        capacity: room.capacity,
        status: room.status,
        creationSource: room.creationSource,
        discoveryMode: room.discoveryMode,
        members: groupEval.members
      }
    };
  } finally {
    if (acquiredLock) {
      await redisService.releaseLock(lockKey);
    }
  }
}

/**
 * Deterministic, non-AI room title derived from the canonical topic.
 * Clamped to the HumrahRoom.title maxlength of 30.
 */
function buildSystemRoomTitle(topic) {
  const t = String(topic || '').trim();
  const withSuffix = `${t} Room`;
  if (withSuffix.length <= 30) return withSuffix;
  if (t.length <= 30) return t;
  return t.slice(0, 30).trim();
}

/**
 * Core Algorithm: Deterministically clusters compatible users.
 */
function buildCandidateGroups(population) {
  const groups = [];
  const assigned = new Set(); // A user is only placed in one group per run to avoid spam

  for (let i = 0; i < population.length; i++) {
    const anchor = population[i];
    if (assigned.has(anchor._id.toString())) continue;

    // Potential group starting with anchor
    const currentGroup = [anchor];
    const candidatePool = [];

    // Find all users passing MIN_PAIRWISE_SCORE with anchor
    for (let j = i + 1; j < population.length; j++) {
      const candidate = population[j];
      if (assigned.has(candidate._id.toString())) continue;

      const pairwise = calculatePairwiseCompatibility(anchor, candidate);
      if (pairwise.eligible && pairwise.overallScore >= CONFIG.MIN_PAIRWISE_SCORE) {
        candidatePool.push({ user: candidate, score: pairwise.overallScore });
      }
    }

    // Sort candidates descending by pairwise score with anchor
    candidatePool.sort((a, b) => b.score - a.score);

    // Greedily attempt to add candidates to group while maintaining cohesion
    for (const c of candidatePool) {
      if (currentGroup.length >= CONFIG.MAX_GROUP_SIZE) break;

      const testGroup = [...currentGroup, c.user];
      const testCohesion = calculateGroupCohesion(testGroup);
      
      // Candidate is viable if the entire group remains strong and all new edges are >= MIN_PAIRWISE
      if (testCohesion.valid && testCohesion.minPairwiseScore >= CONFIG.MIN_PAIRWISE_SCORE) {
        // We only require MIN_COHESION_SCORE when finalizing the group, but we can enforce it here too
        if (testCohesion.cohesionScore >= CONFIG.MIN_COHESION_SCORE) {
          currentGroup.push(c.user);
        }
      }
    }

    // If group is viable, commit it
    if (currentGroup.length >= CONFIG.MIN_GROUP_SIZE) {
      const evalResult = evaluateGroupViability(currentGroup);
      if (evalResult.viable) {
        groups.push({ users: currentGroup, evaluation: evalResult });
        currentGroup.forEach(u => assigned.add(u._id.toString()));
      }
    }
  }

  return groups;
}

/**
 * Main execution pipeline. Intended to be invoked by a cron job or admin endpoint.
 */
async function generateSystemRooms(candidatePopulation, options = {}) {
  // options (all optional, backward compatible with the original 1-arg signature):
  //   discoveryMode : 'ALL_INDIA' (default) | 'NEAR_ME'
  //   maxRooms      : per-call room cap (defaults to CONFIG.MAX_ROOMS_PER_RUN)
  //   silent        : suppress the per-call console summary (driver logs its own)
  const discoveryMode = options.discoveryMode || 'ALL_INDIA';
  const maxRooms = Number.isInteger(options.maxRooms) && options.maxRooms >= 0
    ? options.maxRooms
    : CONFIG.MAX_ROOMS_PER_RUN;

  const log = {
    startedAt: new Date().toISOString(),
    populationCount: candidatePopulation.length,
    discoveryMode,
    groupsEvaluated: 0,
    groupsRejected: 0,
    roomsCreated: 0,
    createdRooms: [],
    rejections: {},
    durationMs: 0
  };
  const startTime = Date.now();

  const viableGroups = buildCandidateGroups(candidatePopulation.slice(0, CONFIG.MAX_CANDIDATES_PER_RUN));
  log.groupsEvaluated = viableGroups.length;

  for (const group of viableGroups.slice(0, maxRooms)) {
    const res = await createSystemRoom(group.evaluation, discoveryMode);
    if (res.success) {
      log.roomsCreated++;
      log.createdRooms.push(res.room);
    } else {
      log.groupsRejected++;
      log.rejections[res.reason] = (log.rejections[res.reason] || 0) + 1;
    }
  }

  log.durationMs = Date.now() - startTime;
  if (!options.silent) {
    console.log('[SystemRoomGenerator] Execution finished:', JSON.stringify({ ...log, createdRooms: log.createdRooms.length }));
  }
  return log;
}

module.exports = {
  CONFIG,
  calculateGroupCohesion,
  selectRoomTopic,
  evaluateGroupViability,
  checkExistingRoom,
  createSystemRoom,
  buildCandidateGroups,
  generateSystemRooms,
  buildSystemRoomTitle
};
