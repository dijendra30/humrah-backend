// utils/roomDiscoveryRanking.js
// -----------------------------------------------------------------------------
// R4.5: deterministic user→Room relevance for the discovery dashboard.
//
// This is NOT a new matching engine. roomMatchingService.js scores user↔user
// pairs for Room GENERATION; this scores a single user against an existing Room
// for ORDERING only. It reuses the exact same explicit questionnaire fields and
// never infers anything from free text or location strings.
//
// Tiers drive the "don't show an empty dashboard" fallback:
//   L1_PERSONAL  — the Room's topic is one the user explicitly picked
//   L2_RELEVANT  — language / city / adjacent-interest signal
//   L3_BROWSE    — valid, open, but no personal signal (honest fallback inventory)
// -----------------------------------------------------------------------------
'use strict';

const TIER = { PERSONAL: 'L1_PERSONAL', RELEVANT: 'L2_RELEVANT', BROWSE: 'L3_BROWSE' };

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const normArr = (a) => (Array.isArray(a) ? a.filter(x => typeof x === 'string').map(norm).filter(Boolean) : []);

/**
 * Builds the reusable signal set for one user from EXISTING questionnaire fields.
 * Missing fields are simply absent — users with sparse profiles still rank, they
 * just land in the broader tiers (backward compatibility requirement).
 */
function buildDiscoveryProfile(user) {
  const q = user?.questionnaire || {};
  return {
    roomInterests: new Set(normArr(q.humrahRoomInterests)),
    conversation: new Set(normArr(q.conversationInterests)),
    languages: new Set(normArr(q.preferredLanguages)),
    city: norm(q.city),
    // Adjacent free-choice signals the user explicitly selected (never inferred).
    adjacent: new Set([
      ...normArr(q.hobbies),
      ...normArr(q.interests),
      ...normArr(q.musicPreference),
      ...normArr(q.comfortActivity),
      ...normArr(q.relaxActivity),
      norm(q.movieGenre),
      norm(q.favoriteFood),
      norm(q.travelPreference),
      norm(q.socialVibe),
    ].filter(Boolean)),
    availableTimes: new Set(normArr(q.availableTimes)),
  };
}

/**
 * Scores one Room for one user. Higher is better. Pure function, no I/O.
 *
 * @param {object} room     HumrahRoom doc (lean ok)
 * @param {object} profile  from buildDiscoveryProfile()
 * @param {object} ctx      { memberCount, isInvited, now }
 * @returns {{score:number, tier:string, reasons:string[]}}
 */
function scoreRoomForUser(room, profile, ctx = {}) {
  const memberCount = Number.isInteger(ctx.memberCount) ? ctx.memberCount : 0;
  const capacity = room.capacity || 0;
  const topic = norm(room.topic);
  const reasons = [];
  let score = 0;
  let tier = TIER.BROWSE;

  // 1. Explicit topic match — the strongest signal the user ever gave us.
  if (topic && profile.roomInterests.has(topic)) {
    score += 100;
    tier = TIER.PERSONAL;
    reasons.push('topic');
  } else if (topic && (profile.conversation.has(topic) || profile.adjacent.has(topic))) {
    score += 45;
    tier = TIER.RELEVANT;
    reasons.push('interest');
  }

  // 2. Language compatibility (a Room with no declared languages excludes nobody).
  const roomLangs = normArr(room.languages);
  if (roomLangs.length > 0 && profile.languages.size > 0) {
    if (roomLangs.some(l => profile.languages.has(l))) {
      score += 25;
      if (tier === TIER.BROWSE) tier = TIER.RELEVANT;
      reasons.push('language');
    } else {
      score -= 30; // no shared language — push down, never hard-exclude
    }
  }

  // 3. An explicit invitation is a direct recruitment signal.
  if (ctx.isInvited) {
    score += 60;
    if (tier === TIER.BROWSE) tier = TIER.RELEVANT;
    reasons.push('invited');
  }

  // 4. Healthy remaining capacity — prefer Rooms someone can actually join,
  //    and slightly prefer Rooms that already have a little life in them.
  const remaining = Math.max(0, capacity - memberCount);
  if (remaining > 0) score += Math.min(remaining, 3) * 4;
  if (memberCount > 0) score += 8;

  // 5. Freshness — newer Rooms first, decaying over 24h.
  const createdAt = room.createdAt ? new Date(room.createdAt).getTime() : 0;
  if (createdAt) {
    const ageHours = Math.max(0, ((ctx.now || Date.now()) - createdAt) / 3600000);
    score += Math.max(0, 12 - ageHours / 2);
  }

  return { score: Math.round(score), tier, reasons };
}

/** Stable ordering: score desc, then newest, then id for determinism. */
function compareScored(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const at = a.room.createdAt ? new Date(a.room.createdAt).getTime() : 0;
  const bt = b.room.createdAt ? new Date(b.room.createdAt).getTime() : 0;
  if (bt !== at) return bt - at;
  return String(a.room._id).localeCompare(String(b.room._id));
}

module.exports = { TIER, buildDiscoveryProfile, scoreRoomForUser, compareScored };
