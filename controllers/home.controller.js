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
