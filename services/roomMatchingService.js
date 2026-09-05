// services/roomMatchingService.js
'use strict';

/**
 * Phase R3.1: Deterministic Humrah Room Matching Engine
 * Evaluates pairwise compatibility for Humrah Rooms without AI or side-effects.
 */

// Weight Configuration
const WEIGHTS = {
  topic: 0.35,        // 35% - Shared Humrah Room interests / Room Topic
  conversation: 0.20, // 20% - Shared Conversation Interests
  language: 0.20,     // 20% - Shared Preferred Languages
  location: 0.10,     // 10% - Proximity / City Match
  availability: 0.05, //  5% - Overlapping Available Times
  socialVibe: 0.05,   //  5% - Same Social Vibe
  vibeWords: 0.03,    //  3% - Shared Vibe Words
  interests: 0.02     //  2% - Shared Hobbies/Interests
};

// Ensure weights sum to 1.0 (approx)
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);

/**
 * Safe normalizer for strings and arrays.
 */
function normalizeString(val) {
  if (typeof val !== 'string') return '';
  return val.trim().toLowerCase();
}

function normalizeArray(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter(val => typeof val === 'string' && val.trim().length > 0).map(normalizeString))];
}

/**
 * Calculates generic Jaccard similarity (intersection / union).
 * If both arrays are empty, returns null (meaning "No Data", should not penalize).
 */
function calculateJaccardScore(arr1, arr2) {
  if (arr1.length === 0 && arr2.length === 0) return null;
  const set1 = new Set(arr1);
  const set2 = new Set(arr2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Calculates overlap where if one has no data, it returns null instead of 0.
 * If at least one intersection exists, gives proportional score.
 */
function calculateOverlapScore(arr1, arr2) {
  if (arr1.length === 0 || arr2.length === 0) return null;
  const set1 = new Set(arr1);
  const set2 = new Set(arr2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  
  if (intersection.size > 0) {
    // If they share at least one thing, that's a positive signal.
    // Max score is 1.0 if they share all of the smaller array.
    const minLen = Math.min(set1.size, set2.size);
    return intersection.size / minLen; 
  }
  return 0; // Explicitly incompatible (they have data, but no overlap)
}

/**
 * Extract normalized profile for matching
 */
function normalizeMatchingProfile(user) {
  const q = user.questionnaire || {};
  return {
    userId: user._id ? user._id.toString() : null,
    city: normalizeString(q.city),
    preferredLanguages: normalizeArray(q.preferredLanguages),
    vibeWords: normalizeArray(q.vibeWords),
    conversationInterests: normalizeArray(q.conversationInterests),
    humrahRoomInterests: normalizeArray(q.humrahRoomInterests),
    availableTimes: normalizeArray(q.availableTimes),
    socialVibe: normalizeString(q.socialVibe),
    hobbies: normalizeArray(q.hobbies),
    interests: normalizeArray(q.interests),
    blockedUsers: (user.blockedUsers || []).map(id => id.toString()),
    // Combine hobbies and interests into one array for generic matching
    combinedInterests: normalizeArray([...(q.hobbies || []), ...(q.interests || [])]),
    liveLocation: user.liveLocation || null
  };
}

/**
 * Check hard eligibility constraints
 */
function checkEligibility(u1, u2) {
  // 1. Blocked User Check
  if (u1.blockedUsers.includes(u2.userId) || u2.blockedUsers.includes(u1.userId)) {
    return { eligible: false, reason: 'blocked' };
  }

  // 2. Language Hard Constraint (Must share at least one language if both provided languages)
  if (u1.preferredLanguages.length > 0 && u2.preferredLanguages.length > 0) {
    const sharedLang = u1.preferredLanguages.some(l => u2.preferredLanguages.includes(l));
    if (!sharedLang) {
      return { eligible: false, reason: 'no_shared_language' };
    }
  }

  return { eligible: true };
}

// Distance helper
const getDistance = (lat1, lon1, lat2, lon2) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

/**
 * Calculates score for pairwise compatibility.
 * Returns { overallScore, components, matchedSignals, missingSignals }
 */
function calculatePairwiseCompatibility(userA, userB, context = {}) {
  const u1 = normalizeMatchingProfile(userA);
  const u2 = normalizeMatchingProfile(userB);

  const eligibility = checkEligibility(u1, u2);
  if (!eligibility.eligible) {
    return { userId: u2.userId, overallScore: 0, components: {}, matchedSignals: [], missingSignals: [], eligible: false, reason: eligibility.reason };
  }

  const components = {};
  const matchedSignals = new Set();
  const missingSignals = new Set();
  let totalScore = 0;
  let activeWeight = 0;

  const evaluateComponent = (name, weight, scoreFunction) => {
    const score = scoreFunction();
    if (score === null) {
      missingSignals.add(name);
      components[name] = null;
    } else {
      components[name] = score;
      totalScore += score * weight;
      activeWeight += weight;
    }
  };

  // 1. Topic (Humrah Room Interests)
  evaluateComponent('topic', WEIGHTS.topic, () => {
    // If context provides a specific room topic, check both against that topic
    if (context.roomTopic) {
      const topic = normalizeString(context.roomTopic);
      const u1Has = u1.humrahRoomInterests.includes(topic);
      const u2Has = u2.humrahRoomInterests.includes(topic);
      if (u1Has && u2Has) {
        matchedSignals.add(topic);
        return 1.0;
      }
      if (u1Has || u2Has) return 0.5; // one has it
      return 0.0;
    }
    // Pairwise overlap
    const score = calculateOverlapScore(u1.humrahRoomInterests, u2.humrahRoomInterests);
    if (score > 0) {
      u1.humrahRoomInterests.filter(t => u2.humrahRoomInterests.includes(t)).forEach(t => matchedSignals.add(t));
    }
    return score;
  });

  // 2. Conversation Interests
  evaluateComponent('conversation', WEIGHTS.conversation, () => {
    const score = calculateOverlapScore(u1.conversationInterests, u2.conversationInterests);
    if (score > 0) {
      u1.conversationInterests.filter(t => u2.conversationInterests.includes(t)).forEach(t => matchedSignals.add(t));
    }
    return score;
  });

  // 3. Language
  evaluateComponent('language', WEIGHTS.language, () => {
    const score = calculateOverlapScore(u1.preferredLanguages, u2.preferredLanguages);
    if (score > 0) {
      u1.preferredLanguages.filter(t => u2.preferredLanguages.includes(t)).forEach(t => matchedSignals.add(t));
    }
    return score;
  });

  // 4. Location
  evaluateComponent('location', WEIGHTS.location, () => {
    // Prioritize live location distance
    if (u1.liveLocation && u1.liveLocation.lat && u2.liveLocation && u2.liveLocation.lat) {
      const dist = getDistance(u1.liveLocation.lat, u1.liveLocation.lng, u2.liveLocation.lat, u2.liveLocation.lng);
      if (dist !== null) {
        if (dist <= 15) return 1.0;
        if (dist <= 50) return 0.8;
        if (dist <= 100) return 0.5;
        return 0.2;
      }
    }
    // Fallback to city
    if (u1.city && u2.city) {
      if (u1.city === u2.city) {
        matchedSignals.add(`City: ${u1.city}`);
        return 1.0;
      }
      return 0.0;
    }
    return null; // missing data
  });

  // 5. Availability
  evaluateComponent('availability', WEIGHTS.availability, () => {
    const score = calculateOverlapScore(u1.availableTimes, u2.availableTimes);
    if (score > 0) {
      u1.availableTimes.filter(t => u2.availableTimes.includes(t)).forEach(t => matchedSignals.add(t));
    }
    return score;
  });

  // 6. Social Vibe
  evaluateComponent('socialVibe', WEIGHTS.socialVibe, () => {
    if (!u1.socialVibe || !u2.socialVibe) return null;
    if (u1.socialVibe === u2.socialVibe) {
      matchedSignals.add(`Vibe: ${u1.socialVibe}`);
      return 1.0;
    }
    return 0.0;
  });

  // 7. Vibe Words
  evaluateComponent('vibeWords', WEIGHTS.vibeWords, () => {
    const score = calculateJaccardScore(u1.vibeWords, u2.vibeWords);
    if (score > 0) {
      u1.vibeWords.filter(t => u2.vibeWords.includes(t)).forEach(t => matchedSignals.add(t));
    }
    return score;
  });

  // 8. Interests / Hobbies
  evaluateComponent('interests', WEIGHTS.interests, () => {
    const score = calculateOverlapScore(u1.combinedInterests, u2.combinedInterests);
    if (score > 0) {
      u1.combinedInterests.filter(t => u2.combinedInterests.includes(t)).forEach(t => matchedSignals.add(t));
    }
    return score;
  });

  // Final Score Normalization (Scale to 100)
  // If activeWeight is 0, it means NO signals were available, score is 0.
  let normalizedScore = 0;
  if (activeWeight > 0) {
    normalizedScore = Math.round((totalScore / activeWeight) * 100);
  }

  return {
    userId: u2.userId,
    overallScore: normalizedScore,
    components,
    matchedSignals: Array.from(matchedSignals),
    missingSignals: Array.from(missingSignals),
    eligible: true
  };
}

module.exports = {
  WEIGHTS,
  normalizeMatchingProfile,
  checkEligibility,
  calculatePairwiseCompatibility,
  getDistance
};
