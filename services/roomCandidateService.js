// services/roomCandidateService.js
// -----------------------------------------------------------------------------
// PHASE 1: production-safe candidate population for the System Room Generator.
//
// This is the missing step between "real users in MongoDB" and the already-built
// deterministic matching (R3.1) + grouping (R3.2) services. It does NOT match, score
// or group anyone — it only decides WHO is eligible to be considered in this run,
// and buckets them for local vs All-India generation.
//
// Design constraints:
//   - never load the whole users collection (bounded .limit + projection)
//   - only explicit, already-trusted profile fields (no inference, no free text)
//   - no new location capture; liveLocation is read only where R3.1 already uses it
//   - exposure/cooldown handled via Redis so it is safe across instances
// -----------------------------------------------------------------------------
'use strict';

const User = require('../models/User');
const HumrahRoom = require('../models/HumrahRoom');
const RoomMember = require('../models/RoomMember');
const redisService = require('./redisService');

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const CANDIDATE_CONFIG = {
  MAX_CANDIDATES: num(process.env.ROOM_GENERATOR_MAX_CANDIDATES, 500),
  CITY_BATCH_SIZE: num(process.env.ROOM_GENERATOR_CITY_BATCH_SIZE, 60),
  USER_COOLDOWN_HOURS: num(process.env.ROOM_GENERATOR_USER_COOLDOWN_HOURS, 24),
  // A user already sitting in this many live Rooms is not offered another one.
  MAX_LIVE_ROOMS_PER_USER: num(process.env.ROOM_GENERATOR_MAX_LIVE_ROOMS_PER_USER, 3),
  // Only seed Rooms with users who can actually be TOLD about them.
  //
  // A SYSTEM Room reaches its members exactly one way: an FCM invitation to a
  // device flagged supportsHumrahRooms. A candidate without one is invited to a
  // Room they will most likely never hear about, and the Room expires unjoined
  // holding a seat that a reachable user could have used.
  //
  // Measured before this gate existed: of 4 seats across two generated Rooms, 2
  // went to users with no registered device at all; the next Room had 2 of 2
  // unreachable and was dead on creation.
  //
  // Off by default would preserve the old behaviour, but the old behaviour is the
  // bug — so this defaults ON. Set ROOM_GENERATOR_REQUIRE_REACHABLE=false to
  // restore the previous, unfiltered selection.
  REQUIRE_REACHABLE: String(process.env.ROOM_GENERATOR_REQUIRE_REACHABLE ?? 'true')
    .trim().toLowerCase() !== 'false',
};

/**
 * Matches a user holding at least one Room-capable device.
 *
 * $elemMatch so BOTH conditions hold on the SAME device — a user with one stale
 * capable-but-tokenless entry and one tokened-but-incapable entry is correctly
 * excluded. Applied inside the Mongo query, so fcmDevices is filtered on the
 * server and never enters CANDIDATE_PROJECTION: no token ever reaches this
 * service, and the projection's privacy guarantee is preserved exactly.
 */
const REACHABLE_FILTER = {
  fcmDevices: {
    $elemMatch: {
      supportsHumrahRooms: true,
      token: { $type: 'string', $ne: '' },
    },
  },
};

const cooldownKey = (userId) => `cooldown:room_generation:user:${userId}`;

/**
 * The only fields R3.1 normalizeMatchingProfile() and R3.2 selectRoomTopic() read.
 * Deliberately excludes email/phone/fcmTokens/fcmDevices/photos.
 */
const CANDIDATE_PROJECTION = '_id questionnaire blockedUsers liveLocation';

/**
 * Loads the eligible candidate population for one generation run.
 *
 * Eligibility (all from existing explicit data):
 *   - account ACTIVE and not suspended
 *   - not a COMPANION account
 *   - has at least one canonical humrahRoomInterests entry
 *     (R3.2 selectRoomTopic cannot pick a topic without this, so anyone else can
 *      never form a viable group — filtering here saves the pairwise work)
 *   - not inside the per-user generation cooldown (Redis)
 *   - has no pending SYSTEM invitation and is not already in too many live Rooms
 *
 * @returns {Promise<{candidates: Array, stats: Object}>}
 */
async function loadRoomCandidates(options = {}) {
  const maxCandidates = options.maxCandidates || CANDIDATE_CONFIG.MAX_CANDIDATES;
  const stats = {
    candidatesFound: 0,
    excludedUnreachable: 0,
    excludedCooldown: 0,
    excludedPendingInvite: 0,
    excludedTooManyRooms: 0,
    candidatesEligible: 0,
  };

  // ── 1. Bounded Mongo query, projected ─────────────────────────────────────
  const baseFilter = {
    status: 'ACTIVE',
    'suspensionInfo.isSuspended': { $ne: true },
    userType: { $ne: 'COMPANION' },
    'questionnaire.humrahRoomInterests.0': { $exists: true },
  };
  const requireReachable = options.requireReachable ?? CANDIDATE_CONFIG.REQUIRE_REACHABLE;
  const filter = requireReachable ? { ...baseFilter, ...REACHABLE_FILTER } : baseFilter;

  const raw = await User.find(filter)
    .select(CANDIDATE_PROJECTION)
    .sort({ _id: 1 })
    .limit(maxCandidates)
    .lean();

  stats.candidatesFound = raw.length;

  // How many otherwise-eligible users the reachability gate removed. Reported so
  // a shrinking Room count is attributable rather than mysterious.
  if (requireReachable) {
    try {
      const total = await User.countDocuments(baseFilter);
      stats.excludedUnreachable = Math.max(0, total - raw.length);
    } catch (err) {
      console.warn('[RoomCandidates] unreachable count failed, continuing:', err.message);
    }
  }
  if (raw.length === 0) return { candidates: [], stats };

  const ids = raw.map(u => u._id);

  // ── 2. Redis cooldown (one pipelined round trip) ───────────────────────────
  let onCooldown = new Set();
  try {
    const hits = await redisService.getMany(ids.map(id => cooldownKey(String(id))));
    onCooldown = new Set(
      [...hits.keys()].map(k => k.slice('cooldown:room_generation:user:'.length))
    );
  } catch (err) {
    // Cooldown is a quality guard, not a correctness guard. If Redis hiccups we
    // still have DB-level duplicate + pending-invite protection below.
    console.warn('[RoomCandidates] cooldown lookup failed, continuing:', err.message);
  }

  // ── 3. Existing Room participation (two bounded queries, no N+1) ───────────
  const liveRooms = await HumrahRoom.find({ status: { $in: ['SUGGESTED', 'ACTIVE', 'FULL'] } })
    .select('_id')
    .lean();
  const liveRoomIds = liveRooms.map(r => r._id);

  const pendingInvite = new Set();
  const liveJoinCount = new Map();
  if (liveRoomIds.length > 0) {
    const memberships = await RoomMember.find({
      roomId: { $in: liveRoomIds },
      userId: { $in: ids },
      status: { $in: ['INVITED', 'JOINED'] },
    })
      .select('userId status')
      .lean();

    memberships.forEach(m => {
      const uid = String(m.userId);
      if (m.status === 'INVITED') {
        // Already has an un-actioned Room opportunity — do not stack another.
        pendingInvite.add(uid);
      } else {
        liveJoinCount.set(uid, (liveJoinCount.get(uid) || 0) + 1);
      }
    });
  }

  // ── 4. Apply exclusions ────────────────────────────────────────────────────
  const candidates = [];
  for (const u of raw) {
    const uid = String(u._id);
    if (onCooldown.has(uid)) { stats.excludedCooldown++; continue; }
    if (pendingInvite.has(uid)) { stats.excludedPendingInvite++; continue; }
    if ((liveJoinCount.get(uid) || 0) >= CANDIDATE_CONFIG.MAX_LIVE_ROOMS_PER_USER) {
      stats.excludedTooManyRooms++;
      continue;
    }
    candidates.push(u);
  }

  stats.candidatesEligible = candidates.length;
  return { candidates, stats };
}

/** Normalized city key used for local bucketing. */
function cityKeyOf(user) {
  const c = user?.questionnaire?.city;
  return typeof c === 'string' && c.trim() ? c.trim().toLowerCase() : null;
}

/**
 * Splits candidates into local (per-city) batches and one All-India pool.
 *
 * A city bucket is used for NEAR_ME generation only when it can actually form a
 * group (>= minGroupSize). Everyone else — no city on file, or a city that is too
 * thin — falls through to the ALL_INDIA pool, where R3.1 relies on topic, language
 * and vibe signals rather than proximity. The driver adds NO extra distance
 * penalty for All India; the 10% location component inside R3.1 is unchanged.
 */
function bucketCandidatesByCity(candidates, opts = {}) {
  const minGroupSize = opts.minGroupSize || 2;
  const cityBatchSize = opts.cityBatchSize || CANDIDATE_CONFIG.CITY_BATCH_SIZE;

  const byCity = new Map();
  const noCity = [];

  for (const u of candidates) {
    const key = cityKeyOf(u);
    if (!key) { noCity.push(u); continue; }
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(u);
  }

  const cityBatches = [];
  const allIndiaPool = [...noCity];

  for (const [city, users] of byCity.entries()) {
    if (users.length < minGroupSize) {
      // Too thin to form a local Room — skip the city, let them try All India.
      allIndiaPool.push(...users);
      continue;
    }
    cityBatches.push({ city, users: users.slice(0, cityBatchSize) });
    if (users.length > cityBatchSize) {
      allIndiaPool.push(...users.slice(cityBatchSize));
    }
  }

  // Deterministic order: biggest cities first, then alphabetical.
  cityBatches.sort((a, b) => (b.users.length - a.users.length) || a.city.localeCompare(b.city));

  return { cityBatches, allIndiaPool };
}

/** Marks users as recently exposed so the next run picks different people. */
async function markUsersExposed(userIds) {
  const ttl = CANDIDATE_CONFIG.USER_COOLDOWN_HOURS * 3600;
  await Promise.all(
    (userIds || []).map(id =>
      redisService.set(cooldownKey(String(id)), 1, ttl).catch(() => {})
    )
  );
}

module.exports = {
  CANDIDATE_CONFIG,
  CANDIDATE_PROJECTION,
  loadRoomCandidates,
  bucketCandidatesByCity,
  markUsersExposed,
  cityKeyOf,
  cooldownKey,
};
