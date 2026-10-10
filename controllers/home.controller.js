// controllers/home.controller.js
'use strict';

const User = require('../models/User');
const MatchingTodayMood = require('../models/MatchingTodayMood');

// =============================================================================
// HELPERS
// =============================================================================

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dL = (lat2-lat1)*Math.PI/180, dG = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getRadiusKm() { const h = new Date().getHours(); return (h >= 21 || h < 6) ? 2 : 5; }
function isNightTime() { const h = new Date().getHours(); return h >= 21 || h < 6; }

function _vibeToEnergy(vibe) {
  if (!vibe) return null;
  return { lowkey: 3, normal: 6, social: 9 }[vibe.toLowerCase()] || null;
}

function calcCompatScore(me, other, maxKm) {
  const mm = me._mtm   || {};
  const om = other._mtm || {};

  const myMood  = mm.mood  ? [mm.mood]  : [];
  const othMood = om.mood  ? [om.mood]  : [];
  const myVibe  = _vibeToEnergy(mm.vibeLevel) || 5;
  const othVibe = _vibeToEnergy(om.vibeLevel) || 5;

  const moodM  = (myMood.filter(m => othMood.includes(m)).length / (Math.max(myMood.length, othMood.length) || 1)) * 40;
  const energM = Math.max(0, 1 - Math.abs(myVibe - othVibe) / 9) * 25;

  const myI = me.questionnaire?.interests  || me.questionnaire?.hangoutPreferences || [];
  const thI = other.questionnaire?.interests || other.questionnaire?.hangoutPreferences || [];
  const intM = (myI.filter(i => thI.includes(i)).length / (Math.max(myI.length, thI.length) || 1)) * 30;

  const distKm = (me.last_known_lat != null && other.last_known_lat != null) ? haversineKm(me.last_known_lat, me.last_known_lng, other.last_known_lat, other.last_known_lng) : maxKm;
  const distB  = Math.max(0, 1 - distKm / maxKm) * 5;

  return Math.round(moodM + energM + intM + distB);
}

// Format a user object exactly like mood-matches and spotlight expected
function formatUser(c, me, maxKm, distKm) {
  const q = c.questionnaire || {};
  const theirInterests = (q.hangoutPreferences || [])
    .concat(q.interests || [])
    .concat(c.interests || [])
    .concat(c.hobbies || []);

  const myInterests = (me.questionnaire?.hangoutPreferences || [])
    .concat(me.questionnaire?.interests || [])
    .concat(me.interests || [])
    .concat(me.hobbies || []);
    
  const overlapCount = myInterests.filter(i => theirInterests.includes(i)).length;

  const distanceLabel = (!distKm || distKm >= 9999) ? null
    : distKm < 1 ? '< 1 km away'
    : `${distKm.toFixed(1)} km away`;

  return {
    _id:                     c._id.toString(), // For compatibility with mood-matches (uses _id)
    id:                      c._id.toString(), // For compatibility with spotlight (uses id)
    firstName:               c.firstName,
    lastName:                c.lastName,
    name:                    `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    profilePhoto:            c.profilePhoto,
    verified:                c.photoVerificationStatus === 'approved',
    photoVerificationStatus: c.photoVerificationStatus || null,
    isPremium:               c.isPremium || false,
    userType:                c.userType,
    distanceKm:              distKm < 9999 ? Math.round(distKm * 10) / 10 : 9999,
    distanceLabel:           distanceLabel,
    compatibilityScore:      calcCompatScore(me, c, maxKm),
    mood:                    c._mtm?.mood || null,
    vibeLevel:               c._mtm?.vibeLevel || null,
    intention:               c._mtm?.intention || null,
    averageRating:           c.ratingStats?.averageRating || 0,
    totalRatings:            c.ratingStats?.totalRatings || 0,
    completedBookings:       c.ratingStats?.completedBookings || 0,
    
    // Profile preview fields for Review sheet
    profilePreview: {
      bio:                q.bio || c.bio || null,
      tagline:            q.tagline || c.tagline || null,
      vibeWords:          q.vibeWords || c.vibeWords || null,
      sharedHangouts:     theirInterests.length > 0 ? theirInterests : null,
      overlapCount:       overlapCount,
      availableTimes:     q.availableTimes || c.availableTimes || null,
      languagePreference: q.languagePreference || c.language || c.languagePreference || null,
      costSharing:        q.price || c.price || null,
      costSharingPreference: q.costSharingPreference || null,
      city:               c.liveLocation?.city || q.city || c.city || null,
      state:              c.liveLocation?.state || q.state || c.state || null,
      availability:       q.availability || c.availability || null,
      comfortZones:       q.comfortZones || c.comfortZones || null,
    }
  };
}

// =============================================================================
// GET /api/home/nearby
// =============================================================================
exports.getNearbyUsers = async (req, res) => {
  try {
    const now = new Date();
    const MAX_KM = getRadiusKm();
    const night = isNightTime();

    // ── Requesting user ───────────────────────────────────────────────────────
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng last_location_updated_at questionnaire blockedUsers status liveLocation tagline bio interests hobbies vibeWords availableTimes languagePreference language price city state availability comfortZones')
      .lean();
      
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    const blockedIds = (me.blockedUsers || []).map(id => id.toString());
    const usersWhoBlockedMe = await User.find({ blockedUsers: req.userId }, { _id: 1 }).lean();
    blockedIds.push(...usersWhoBlockedMe.map(u => u._id.toString()));
    blockedIds.push(req.userId.toString()); // don't return self

    // My active mood
    const myMTM = await MatchingTodayMood.findOne({
      userId: req.userId,
      visible: true,
      expiresAt: { $gt: now },
    }).lean();
    
    me._mtm = myMTM;

    // ── Base Query ────────────────────────────────────────────────────────────
    // Find all active users with profile photos (Base users)
    const filter = {
      _id: { $nin: blockedIds },
      status: 'ACTIVE',
      profilePhoto: { $ne: null }
    };

    const userLat = me.liveLocation?.lat ?? me.last_known_lat ?? null;
    const userLng = me.liveLocation?.lng ?? me.last_known_lng ?? null;
    const userCity = me.liveLocation?.city?.trim().toLowerCase() || me.questionnaire?.city?.trim().toLowerCase() || null;

    if (userLat !== null && userLng !== null) {
      // Use bounding box if we have coordinates
      const dLat = MAX_KM / 111.0;
      const dLng = MAX_KM / (111.0 * Math.cos(userLat * Math.PI / 180));
      const radiusRadians = MAX_KM / 6378.1;
      
      // We also fallback to city for users without live coordinates if they share the same city
      if (userCity) {
         const titleCity = userCity.charAt(0).toUpperCase() + userCity.slice(1);
         filter.$or = [
            { 'liveLocation.coordinates': { $geoWithin: { $centerSphere: [ [userLng, userLat], radiusRadians ] } } },
            { last_known_lat: { $gte: userLat - dLat, $lte: userLat + dLat }, last_known_lng: { $gte: userLng - dLng, $lte: userLng + dLng } },
            { 'liveLocation.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } },
            { 'questionnaire.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } }
         ];
      } else {
         filter.$or = [
            { 'liveLocation.coordinates': { $geoWithin: { $centerSphere: [ [userLng, userLat], radiusRadians ] } } },
            { last_known_lat: { $gte: userLat - dLat, $lte: userLat + dLat }, last_known_lng: { $gte: userLng - dLng, $lte: userLng + dLng } }
         ];
      }
    } else if (userCity) {
       // City only fallback
       const titleCity = userCity.charAt(0).toUpperCase() + userCity.slice(1);
       filter.$or = [
         { 'liveLocation.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } },
         { 'questionnaire.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } }
       ];
    } else {
       console.log(`[Nearby] User ${req.userId} missing both coordinates and city. Exiting.`);
       return res.json({ success: true, users: [], moodMatches: [], verifiedUsers: [], nearbyUsers: [] });
    }

    const candidates = await User.find(filter)
      .select('firstName lastName profilePhoto verified photoVerificationStatus isPremium userType ratingStats last_known_lat last_known_lng questionnaire liveLocation tagline bio interests hobbies vibeWords availableTimes languagePreference language price city state availability comfortZones')
      .limit(300)
      .lean();
      
    console.log(`[Nearby] Base users from DB: ${candidates.length}`);

    // Fetch active moods for all candidates
    const candidateIds = candidates.map(c => c._id);
    const activeMTMs = await MatchingTodayMood.find({
      userId: { $in: candidateIds },
      visible: true,
      expiresAt: { $gt: now },
    }).lean();

    const mtmByUser = {};
    activeMTMs.forEach(d => { mtmByUser[d.userId.toString()] = d; });
    candidates.forEach(c => { c._mtm = mtmByUser[c._id.toString()] || null; });

    // ── Distance Filtering ──────────────────────────────────────────────────
    let afterDistance = [];
    for (const c of candidates) {
       const cLat = c.liveLocation?.lat ?? c.last_known_lat ?? null;
       const cLng = c.liveLocation?.lng ?? c.last_known_lng ?? null;
       
       let distKm = 9999;
       
       if (userLat !== null && userLng !== null && cLat !== null && cLng !== null) {
          distKm = haversineKm(userLat, userLng, cLat, cLng);
          // If they have coordinates but are outside the radius, exclude them
          if (distKm > MAX_KM) {
             console.log(`[Nearby] Excluded user ${c._id}: outside radius (${distKm.toFixed(1)}km > ${MAX_KM}km)`);
             continue;
          }
       } else {
          // If distance cannot be calculated because coordinates are missing,
          // EXCLUDE distance filtering and still show users (Task #6)
          console.log(`[Nearby] User ${c._id}: missing coordinates, skipping distance filter`);
       }
       
       afterDistance.push(formatUser(c, me, MAX_KM, distKm));
    }
    
    console.log(`[Nearby] After distance filter: ${afterDistance.length}`);
    
    // Sort logic (night vs day)
    afterDistance.sort(night
      ? (a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || b.compatibilityScore - a.compatibilityScore
      : (a, b) => b.compatibilityScore - a.compatibilityScore
    );

    // ── Splitting Users ─────────────────────────────────────────────────────
    
    // People Nearby: Companions only
    const nearbyUsers = afterDistance.filter(u => u.userType === 'COMPANION');

    // Mood Matches: baseUsers.filter(hasActiveMood)
    const moodMatches = afterDistance.filter(u => u.mood != null);
    console.log(`[Nearby] After mood filter: ${moodMatches.length}`);
    
    // Verified: baseUsers.filter(isVerified)
    const verifiedUsers = afterDistance.filter(u => u.verified === true);
    console.log(`[Nearby] After verified filter: ${verifiedUsers.length}`);

    res.json({
      success: true,
      users: afterDistance, // For fallback legacy clients
      moodMatches: moodMatches,
      verifiedUsers: verifiedUsers,
      nearbyUsers: nearbyUsers
    });

  } catch (err) {
    console.error('[Nearby]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// =============================================================================
// GET /api/home/people-nearby
// =============================================================================
//
// Additive endpoint for the NEW Humrah Home's "People Near You" section.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// getNearbyUsers() above serves the PUBLISHED Play Store app, whose Companion
// section reads its `nearbyUsers` array — deliberately
// `afterDistance.filter(u => u.userType === 'COMPANION')`. The new Home needs
// MEMBERS *and* COMPANIONS. Rather than widen that array (which would silently
// change the published app, with no API versioning to scope it), the new client
// gets its own route. The two paths are now fully isolated:
//
//     /api/home/nearby        → published app  → nearbyUsers → COMPANION only
//     /api/home/people-nearby → new Home       → users       → MEMBER + COMPANION
//
// ── Why this duplicates the orchestration instead of extracting it ───────────
// Every piece of non-trivial logic IS shared: haversineKm(), getRadiusKm(),
// isNightTime(), calcCompatScore() and formatUser() are all reused verbatim
// below, so distance maths, radius policy, scoring and the user payload shape
// can never drift between the two endpoints.
//
// What is repeated is only the query/filter orchestration. That was a deliberate
// call: extracting it would mean rewriting the body of getNearbyUsers(), which
// the published app depends on, in a repo with no test suite and no way to run
// the server against a database from the dev environment. Leaving that function
// byte-for-byte untouched is worth ~80 lines of repetition. Once this endpoint
// has been proven in production, collapsing both onto a shared helper is a safe
// follow-up.
//
// ⚠️ Any change to eligibility, radius, blocking or safety rules must be applied
// to BOTH functions until that consolidation happens.
// =============================================================================
exports.getPeopleNearby = async (req, res) => {
  // Opt-in discovery mode (new Home + See all; see getPeopleDiscovery below). Without
  // `discovery=1` this endpoint behaves exactly as before, for older app builds.
  if (req.query && (req.query.discovery === '1' || req.query.discovery === 'true')) return getPeopleDiscovery(req, res);
  try {
    const now = new Date();
    const MAX_KM = getRadiusKm();
    const night = isNightTime();

    // ── Requesting user ───────────────────────────────────────────────────────
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng last_location_updated_at questionnaire blockedUsers status liveLocation tagline bio interests hobbies vibeWords availableTimes languagePreference language price city state availability comfortZones')
      .lean();

    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    // ── Exclusions: blocked both ways, plus self ──────────────────────────────
    const blockedIds = (me.blockedUsers || []).map(id => id.toString());
    const usersWhoBlockedMe = await User.find({ blockedUsers: req.userId }, { _id: 1 }).lean();
    blockedIds.push(...usersWhoBlockedMe.map(u => u._id.toString()));
    blockedIds.push(req.userId.toString()); // don't return self

    // My active mood — drives compatibility scoring only, never eligibility.
    const myMTM = await MatchingTodayMood.findOne({
      userId: req.userId,
      visible: true,
      expiresAt: { $gt: now },
    }).lean();

    me._mtm = myMTM;

    // ── Base Query ────────────────────────────────────────────────────────────
    // Identical to getNearbyUsers(): active accounts with a profile photo, minus
    // blocked users. NOTE: no userType condition — MEMBERS and COMPANIONS are
    // both eligible here. That is the single intended difference between the two
    // endpoints, and it lives in the response, not in this filter.
    const filter = {
      _id: { $nin: blockedIds },
      status: 'ACTIVE',
      profilePhoto: { $ne: null }
    };

    const userLat = me.liveLocation?.lat ?? me.last_known_lat ?? null;
    const userLng = me.liveLocation?.lng ?? me.last_known_lng ?? null;
    const userCity = me.liveLocation?.city?.trim().toLowerCase() || me.questionnaire?.city?.trim().toLowerCase() || null;

    if (userLat !== null && userLng !== null) {
      const dLat = MAX_KM / 111.0;
      const dLng = MAX_KM / (111.0 * Math.cos(userLat * Math.PI / 180));
      const radiusRadians = MAX_KM / 6378.1;

      if (userCity) {
        const titleCity = userCity.charAt(0).toUpperCase() + userCity.slice(1);
        filter.$or = [
          { 'liveLocation.coordinates': { $geoWithin: { $centerSphere: [ [userLng, userLat], radiusRadians ] } } },
          { last_known_lat: { $gte: userLat - dLat, $lte: userLat + dLat }, last_known_lng: { $gte: userLng - dLng, $lte: userLng + dLng } },
          { 'liveLocation.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } },
          { 'questionnaire.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } }
        ];
      } else {
        filter.$or = [
          { 'liveLocation.coordinates': { $geoWithin: { $centerSphere: [ [userLng, userLat], radiusRadians ] } } },
          { last_known_lat: { $gte: userLat - dLat, $lte: userLat + dLat }, last_known_lng: { $gte: userLng - dLng, $lte: userLng + dLng } }
        ];
      }
    } else if (userCity) {
      const titleCity = userCity.charAt(0).toUpperCase() + userCity.slice(1);
      filter.$or = [
        { 'liveLocation.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } },
        { 'questionnaire.city': { $in: [userCity, titleCity, userCity.toUpperCase()] } }
      ];
    } else {
      console.log(`[PeopleNearby] User ${req.userId} missing both coordinates and city. Exiting.`);
      return res.json({ success: true, users: [] });
    }

    const candidates = await User.find(filter)
      .select('firstName lastName profilePhoto verified photoVerificationStatus isPremium userType ratingStats last_known_lat last_known_lng questionnaire liveLocation tagline bio interests hobbies vibeWords availableTimes languagePreference language price city state availability comfortZones')
      .limit(300)
      .lean();

    console.log(`[PeopleNearby] Base users from DB: ${candidates.length}`);

    // Active moods for all candidates — one bulk query, never per-user.
    const candidateIds = candidates.map(c => c._id);
    const activeMTMs = await MatchingTodayMood.find({
      userId: { $in: candidateIds },
      visible: true,
      expiresAt: { $gt: now },
    }).lean();

    const mtmByUser = {};
    activeMTMs.forEach(d => { mtmByUser[d.userId.toString()] = d; });
    candidates.forEach(c => { c._mtm = mtmByUser[c._id.toString()] || null; });

    // ── Distance Filtering ────────────────────────────────────────────────────
    const people = [];
    for (const c of candidates) {
      const cLat = c.liveLocation?.lat ?? c.last_known_lat ?? null;
      const cLng = c.liveLocation?.lng ?? c.last_known_lng ?? null;

      let distKm = 9999;

      if (userLat !== null && userLng !== null && cLat !== null && cLng !== null) {
        distKm = haversineKm(userLat, userLng, cLat, cLng);
        if (distKm > MAX_KM) continue;
      }
      // Missing coordinates → kept, same as getNearbyUsers() (Task #6).

      // Reuses the shared formatter, so the per-user payload — including
      // userType and profilePreview.costSharing — is identical to the existing
      // endpoint's. conversationInterests is then added on top, for this
      // endpoint only; the published app's response shape is untouched.
      const formatted = formatUser(c, me, MAX_KM, distKm);
      formatted.conversationInterests = c.questionnaire?.conversationInterests || null;

      people.push(formatted);
    }

    console.log(`[PeopleNearby] After distance filter: ${people.length}`);

    // Same ordering policy as getNearbyUsers(): verified-first at night, then
    // compatibility. Deliberately NOT grouped by userType — MEMBERS and
    // COMPANIONS interleave so the section reads as nearby people.
    people.sort(night
      ? (a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || b.compatibilityScore - a.compatibilityScore
      : (a, b) => b.compatibilityScore - a.compatibilityScore
    );

    res.json({ success: true, users: people });

  } catch (err) {
    console.error('[PeopleNearby]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// =============================================================================
// GET /api/home/people-nearby?discovery=1&page=1&limit=20&seed=123
// =============================================================================
//
// OPT-IN discovery mode for the new Home's People Near You (Home shows the first
// five; See all pages through the rest). Without `discovery=1` the endpoint above
// behaves exactly as before, so older app builds are unaffected; /api/home/nearby
// (the published app) is not touched at all.
//
// Matching first, never empty just because nobody shares an interest. One ranked
// list, in these pools (each user appears once, in the first pool they qualify for):
//
//   1. NEARBY_COMPANION  Companions with a REAL distance inside the existing radius
//                        (2 km at night, 5 km by day) — at most two.
//   2. NEARBY_MATCH      Members inside the radius with a real shared signal.
//   3. NEARBY_GENERAL    Other Members inside the radius (no claimed match).
//   4. INDIA_MATCH       Members elsewhere (beyond the radius / unknown location) with
//                        a real shared signal.
//   5. INDIA_GENERAL     Other Members elsewhere.
//   6. MORE_COMPANION    Any further Companions — never presented as nearby unless
//                        they really are inside the radius.
//
// Real signals only: the DISTINCT shared items of hangout preferences / interests /
// hobbies (both users' own profile data), and the same active mood today. The
// generic compatibilityScore is NOT used as evidence (its energy + distance parts make
// everyone score > 0).
//
// Inside a pool: relevance tier first, then a blended priority — opposite gender (a
// preference, never a filter; both genders must be known Man/Woman), distance band and
// profile completeness — then a controlled shuffle only among exact ties. The shuffle is
// seeded by the client's `seed`, so pages of one browsing session never reorder; a new
// seed (pull-to-refresh) may reshuffle ties only. Gender is never sent to the client.
//
// Same safety rules as the endpoint above: ACTIVE accounts with a photo, blocked in
// either direction excluded, self excluded. No coordinates leave the server; people
// beyond the radius get a coarse label ("In your city", "In Mumbai", "Across India").
// The India-wide pool is a bounded query on the existing { status, userType, _id }
// index (newest accounts first), never the whole user collection.
// =============================================================================
const DISCOVERY_PAGE_MAX = 50;
const DISCOVERY_BROAD_LIMIT = 400;

function _norm(v) { return String(v || '').trim().toLowerCase(); }
function _interestSet(u) {
  const q = u.questionnaire || {};
  return new Set([...(q.hangoutPreferences || []), ...(q.interests || []), ...(q.hobbies || []),
    ...(u.interests || []), ...(u.hobbies || [])].map(_norm).filter(Boolean));
}
function _binaryGender(g) {
  const v = _norm(g);
  if (v === 'man' || v === 'male' || v === 'm') return 'M';
  if (v === 'woman' || v === 'female' || v === 'f') return 'F';
  return null;
}
function _cityOf(u) { return _norm((u.liveLocation && u.liveLocation.city) || (u.questionnaire && u.questionnaire.city) || u.city); }
function _titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }
// Deterministic PRNG for the controlled shuffle (mulberry32).
function _rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function _hash(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * Pure ranking (exported for tests): candidates already carry the fields below.
 *   { user, isCompanion, nearby (bool), distBand (0..3), shared (int), sameMood (bool),
 *     preferred (bool), completeness (0..2) }
 */
function rankDiscovery(candidates, seed) {
  const rand = _rng(seed);
  const tierOf = c => (c.shared >= 3 || (c.shared >= 1 && c.sameMood)) ? 3 : (c.shared === 2 || c.sameMood) ? 2 : (c.shared === 1 ? 1 : 0);
  // Blended priority within a tier: one distance band ≈ the gender preference.
  const prio = c => (c.preferred ? 2 : 0) + (3 - c.distBand) * 2 + c.completeness;
  const ordered = list => {
    const groups = new Map();
    for (const c of list) {
      const k = `${tierOf(c)}|${prio(c)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      const [ta, pa] = a.split('|').map(Number); const [tb, pb] = b.split('|').map(Number);
      return (tb - ta) || (pb - pa);
    });
    const out = [];
    for (const k of keys) {
      // Stable base order, then a seeded Fisher–Yates among exact ties only.
      const g = groups.get(k).sort((x, y) => String(x.user._id).localeCompare(String(y.user._id)));
      for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [g[i], g[j]] = [g[j], g[i]]; }
      out.push(...g);
    }
    return out;
  };
  const seen = new Set();
  const unique = candidates.filter(c => { const id = String(c.user._id); if (seen.has(id)) return false; seen.add(id); return true; });

  const nearbyCompanions = ordered(unique.filter(c => c.isCompanion && c.nearby));
  const pool = (name, list) => list.map(c => ({ ...c, pool: name, tier: tierOf(c) }));
  const p1 = pool('NEARBY_COMPANION', nearbyCompanions.slice(0, 2));
  const members = unique.filter(c => !c.isCompanion);
  const p2 = pool('NEARBY_MATCH', ordered(members.filter(c => c.nearby && tierOf(c) > 0)));
  const p3 = pool('NEARBY_GENERAL', ordered(members.filter(c => c.nearby && tierOf(c) === 0)));
  const p4 = pool('INDIA_MATCH', ordered(members.filter(c => !c.nearby && tierOf(c) > 0)));
  const p5 = pool('INDIA_GENERAL', ordered(members.filter(c => !c.nearby && tierOf(c) === 0)));
  const p6 = pool('MORE_COMPANION', [
    ...nearbyCompanions.slice(2),
    ...ordered(unique.filter(c => c.isCompanion && !c.nearby)),
  ]);
  return [...p1, ...p2, ...p3, ...p4, ...p5, ...p6];
}

async function getPeopleDiscovery(req, res) {
  try {
    const now = new Date();
    const MAX_KM = getRadiusKm();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(DISCOVERY_PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const seed = Number.isFinite(Number(req.query.seed)) && req.query.seed !== '' && req.query.seed != null
      ? (Number(req.query.seed) >>> 0) : (Math.floor(Math.random() * 2 ** 31) >>> 0);

    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng questionnaire blockedUsers status liveLocation interests hobbies city')
      .lean();
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    // Exclusions: blocked both ways, plus self — exactly as above.
    const blockedIds = (me.blockedUsers || []).map(id => id.toString());
    const usersWhoBlockedMe = await User.find({ blockedUsers: req.userId }, { _id: 1 }).lean();
    blockedIds.push(...usersWhoBlockedMe.map(u => u._id.toString()));
    blockedIds.push(req.userId.toString());

    const myMTM = await MatchingTodayMood.findOne({ userId: req.userId, visible: true, expiresAt: { $gt: now } }).lean();
    me._mtm = myMTM;

    const select = 'firstName lastName profilePhoto verified photoVerificationStatus isPremium userType ratingStats last_known_lat last_known_lng questionnaire liveLocation tagline bio interests hobbies vibeWords availableTimes languagePreference language price city state availability comfortZones profileCompletion';
    const base = { _id: { $nin: blockedIds }, status: 'ACTIVE', profilePhoto: { $ne: null } };

    // Local candidates: the same radius / city query as the endpoint above.
    const userLat = me.liveLocation?.lat ?? me.last_known_lat ?? null;
    const userLng = me.liveLocation?.lng ?? me.last_known_lng ?? null;
    const myCity = _cityOf(me) || null;
    let local = [];
    if (userLat !== null && userLng !== null) {
      const dLat = MAX_KM / 111.0;
      const dLng = MAX_KM / (111.0 * Math.cos(userLat * Math.PI / 180));
      const or = [
        { 'liveLocation.coordinates': { $geoWithin: { $centerSphere: [[userLng, userLat], MAX_KM / 6378.1] } } },
        { last_known_lat: { $gte: userLat - dLat, $lte: userLat + dLat }, last_known_lng: { $gte: userLng - dLng, $lte: userLng + dLng } },
      ];
      if (myCity) {
        const t = _titleCase(myCity);
        or.push({ 'liveLocation.city': { $in: [myCity, t, myCity.toUpperCase()] } }, { 'questionnaire.city': { $in: [myCity, t, myCity.toUpperCase()] } });
      }
      local = await User.find({ ...base, $or: or }).select(select).limit(300).lean();
    } else if (myCity) {
      const t = _titleCase(myCity);
      local = await User.find({ ...base, $or: [{ 'liveLocation.city': { $in: [myCity, t, myCity.toUpperCase()] } }, { 'questionnaire.city': { $in: [myCity, t, myCity.toUpperCase()] } }] })
        .select(select).limit(300).lean();
    }

    // Broader India: bounded, on the { status, userType, _id } index, newest first.
    const localIds = local.map(u => u._id);
    const broad = await User.find({ ...base, _id: { $nin: [...blockedIds, ...localIds.map(String)] }, userType: { $in: ['MEMBER', 'COMPANION'] } })
      .select(select).sort({ _id: -1 }).limit(DISCOVERY_BROAD_LIMIT).lean();

    const all = [...local, ...broad];
    const moods = await MatchingTodayMood.find({ userId: { $in: all.map(u => u._id) }, visible: true, expiresAt: { $gt: now } }).lean();
    const moodBy = new Map(moods.map(d => [d.userId.toString(), d]));

    const mine = _interestSet(me);
    const myGender = _binaryGender(me.questionnaire && me.questionnaire.gender);
    const candidates = all.map(u => {
      u._mtm = moodBy.get(u._id.toString()) || null;
      const cLat = u.liveLocation?.lat ?? u.last_known_lat ?? null;
      const cLng = u.liveLocation?.lng ?? u.last_known_lng ?? null;
      const distKm = (userLat !== null && userLng !== null && cLat !== null && cLng !== null) ? haversineKm(userLat, userLng, cLat, cLng) : null;
      const nearby = distKm !== null && distKm <= MAX_KM;
      const theirs = _interestSet(u);
      let shared = 0;
      const sharedItems = [];
      for (const i of theirs) if (mine.has(i)) { shared++; if (sharedItems.length < 3) sharedItems.push(i); }
      const sameMood = !!(myMTM && myMTM.mood && u._mtm && u._mtm.mood && u._mtm.mood === myMTM.mood);
      const theirGender = _binaryGender(u.questionnaire && u.questionnaire.gender);
      const city = _cityOf(u);
      const distBand = nearby ? (distKm <= 1 ? 0 : distKm <= 3 ? 1 : 2) : (myCity && city === myCity ? 2 : 3);
      const pc = Number(u.profileCompletion) || 0;
      const locationLabel = nearby ? (distKm < 1 ? '< 1 km away' : `${distKm.toFixed(1)} km away`)
        : (myCity && city === myCity ? 'In your city' : city ? `In ${_titleCase(city)}` : 'Across India');
      return {
        user: u, distKm: nearby ? distKm : null, isCompanion: u.userType === 'COMPANION', nearby, distBand, shared, sharedItems, sameMood,
        preferred: !!(myGender && theirGender && myGender !== theirGender),
        completeness: pc >= 80 ? 2 : pc >= 50 ? 1 : 0, locationLabel,
      };
    });

    const ranked = rankDiscovery(candidates, (seed ^ _hash(req.userId)) >>> 0);
    const start = (page - 1) * limit;
    const slice = ranked.slice(start, start + limit);
    const users = slice.map(c => {
      const f = formatUser(c.user, me, MAX_KM, c.nearby ? c.distKm : 9999);
      // Distance only for people genuinely inside the radius; everyone else a coarse label.
      f.distanceLabel = c.locationLabel;
      f.conversationInterests = c.user.questionnaire?.conversationInterests || null;
      f.discoveryPool = c.pool;
      f.isNearby = c.nearby;
      f.locationLabel = c.locationLabel;
      f.sharedInterestCount = c.shared;          // distinct, verified on both profiles
      f.sameMood = c.sameMood;
      return f;
    });
    res.json({ success: true, users, page, limit, seed, total: ranked.length, hasMore: start + limit < ranked.length });
  } catch (err) {
    console.error('[PeopleDiscovery]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

exports.getPeopleDiscovery = getPeopleDiscovery;
exports._rankDiscovery = rankDiscovery;
