// services/roomProximityService.js
// -----------------------------------------------------------------------------
// The ONE canonical "is this user nearby enough for this Room?" rule.
//
// WHY THIS FILE EXISTS: the NEAR_ME proximity rule was previously expressed only
// inline inside roomController.discoverRooms — the expanding-radius geo lookup at
// the top of that handler. R4.5's buildDiscoveryInventory, added later, built its
// own Room inventory and had NO proximity constraint at all, which is how a
// user-created NEAR_ME Room became visible platform-wide.
//
// Extracting the rule here means there is exactly one definition of "nearby" and
// both paths read it. This file introduces NO new distance algorithm:
//   - the radii are the existing 5 / 8 / 10 / 15 km ladder
//   - proximity is measured requester <-> Room CREATOR, both from server-side
//     trusted locations, exactly as the existing geo path measured it
//   - the distance buckets are the existing '< 5 km' / '5-8 km' / '8-10 km' /
//     '10-15 km' labels, character for character
//
// TRUST BOUNDARY: every location read here comes from the User document. Nothing
// in this file accepts a coordinate, a radius or a distance from a request.
// -----------------------------------------------------------------------------
'use strict';

const User = require('../models/User');

/**
 * The existing expanding-radius ladder, in metres. discoverRooms walks these in
 * order to fill its result list; the VISIBILITY boundary is the outermost value.
 *
 * The ladder is a result-count heuristic ("widen until something is found"), not
 * four different eligibility rules — a Room found at 5 km is also within 15 km.
 * Using the outer bound as the gate is therefore the union of the existing tiers,
 * not a new rule, and it avoids the absurdity of a Room's visibility depending on
 * how many OTHER Rooms happen to exist near the requester.
 */
const NEARBY_RADII_METERS = Object.freeze([5000, 8000, 10000, 15000]);
const MAX_NEARBY_RADIUS_METERS = NEARBY_RADII_METERS[NEARBY_RADII_METERS.length - 1];

/**
 * Resolves a user's server-side trusted location.
 *
 * liveLocation first, then the legacy last_known_* pair — the same precedence
 * discoverRooms already expressed. Returns null when neither is usable, and null
 * MUST be treated as "not eligible for any NEAR_ME Room", never as a reason to
 * fall back to a wider audience.
 */
function getTrustedLocation(user) {
  if (!user) return null;
  const lat = Number.isFinite(user.liveLocation?.lat) ? user.liveLocation.lat : user.last_known_lat;
  const lng = Number.isFinite(user.liveLocation?.lng) ? user.liveLocation.lng : user.last_known_lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * The existing distance buckets. Extracted verbatim from discoverRooms so the
 * seeded path and the inventory path can never disagree on a label.
 *
 * Deliberately coarse: Android is shown a bucket, never a distance, and never a
 * coordinate.
 */
function distanceTierFor(km) {
  if (!Number.isFinite(km)) return 'Near Me';
  if (km <= 5) return '< 5 km';
  if (km <= 8) return '5-8 km';
  if (km <= 10) return '8-10 km';
  return '10-15 km';
}

/** Haversine, in km. Same formula as the getDistance helper in roomController. */
function distanceKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return NaN;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Does this Room need the NEAR_ME visibility gate?
 *
 * ONLY user-created NEAR_ME Rooms. SYSTEM-generated Rooms are excluded on
 * purpose: the generator also emits discoveryMode 'NEAR_ME' Rooms, they have no
 * createdBy at all (HumrahRoom.createdBy is required only when
 * creationSource === 'USER'), and their discovery behaviour is R4.5's, which this
 * fix must not change.
 */
function requiresNearMeGate(room) {
  if (!room) return false;
  return room.discoveryMode === 'NEAR_ME'
    && (room.creationSource || 'USER') === 'USER'
    && Boolean(room.createdBy);
}

/**
 * Which of `creatorIds` are within the canonical nearby radius of `viewer`?
 *
 * Uses the SAME mechanism as the existing geo path: a $near query against the
 * 2dsphere index on User.liveLocation. The candidate set is narrowed to the given
 * creator ids first, so the cost is bounded by the number of Rooms on the
 * dashboard rather than by the size of the user base.
 *
 * @returns {Promise<Map<string,{lat:number,lng:number}>>} eligible creator id ->
 *          that creator's trusted coordinates, for distance-tier labelling.
 *          An EMPTY map means nobody is eligible — which is also what a viewer
 *          with no trusted location gets.
 */
async function findNearbyCreators(viewer, creatorIds, { radiusMeters = MAX_NEARBY_RADIUS_METERS } = {}) {
  const out = new Map();

  const origin = getTrustedLocation(viewer);
  // No trusted location => no proximity can be established => nothing is nearby.
  // This is the fail-closed branch that Test 3 pins: it must NOT widen to
  // ALL_INDIA and it must NOT return the Room.
  if (!origin) return out;

  const ids = Array.from(new Set((creatorIds || []).filter(Boolean).map(String)));
  if (ids.length === 0) return out;

  const nearby = await User.find({
    _id: { $in: ids },
    liveLocation: {
      $near: {
        $geometry: { type: 'Point', coordinates: [origin.lng, origin.lat] },
        $maxDistance: radiusMeters,
      },
    },
  }).select('_id liveLocation.lat liveLocation.lng').lean();

  nearby.forEach(u => {
    out.set(String(u._id), {
      lat: u.liveLocation?.lat ?? null,
      lng: u.liveLocation?.lng ?? null,
    });
  });
  return out;
}

/**
 * The complete gate for one dashboard build.
 *
 * @returns {Promise<{eligibleCreators:Map, tierForRoom:Function}>}
 *          tierForRoom(room) gives the existing bucketed label for an eligible
 *          Room, or null when the Room is not gated.
 */
async function buildNearMeVisibility(viewer, rooms) {
  const gated = (rooms || []).filter(requiresNearMeGate);
  if (gated.length === 0) {
    return { eligibleCreators: new Map(), tierForRoom: () => null, gatedCount: 0 };
  }

  const eligibleCreators = await findNearbyCreators(viewer, gated.map(r => r.createdBy));
  const origin = getTrustedLocation(viewer);

  const tierForRoom = (room) => {
    if (!requiresNearMeGate(room) || !origin) return null;
    const creator = eligibleCreators.get(String(room.createdBy));
    if (!creator) return null;
    return distanceTierFor(distanceKm(origin.lat, origin.lng, creator.lat, creator.lng));
  };

  return { eligibleCreators, tierForRoom, gatedCount: gated.length };
}

/** Is this viewer allowed to SEE this Room? The single visibility predicate. */
function isRoomVisibleTo(room, eligibleCreators) {
  if (!requiresNearMeGate(room)) return true;      // ALL_INDIA + SYSTEM: unchanged
  return eligibleCreators.has(String(room.createdBy));
}

module.exports = {
  NEARBY_RADII_METERS,
  MAX_NEARBY_RADIUS_METERS,
  getTrustedLocation,
  distanceTierFor,
  distanceKm,
  requiresNearMeGate,
  findNearbyCreators,
  buildNearMeVisibility,
  isRoomVisibleTo,
};
