// controllers/spotlight.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// LOCATION PRIORITY: liveLocation.city (GPS-based, from MatchmakingLocationManager)
//   > questionnaire.city (static onboarding data — fallback only)
//
// Companions are filtered by the REQUESTING USER's live city, not their own
// profile city. This ensures "People Nearby" shows people actually near you,
// not people who signed up in the same city during onboarding.
// ─────────────────────────────────────────────────────────────────────────────
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK FILTERING HELPER
// Returns IDs to exclude + current user's location for nearby filtering.
// ─────────────────────────────────────────────────────────────────────────────
async function getExcludeIds(currentUserId) {
  const currentUser = await User.findById(currentUserId)
    .select('questionnaire blockedUsers liveLocation last_known_lat last_known_lng');

  if (!currentUser) {
    console.warn(`[DB] getExcludeIds — user ${currentUserId} not found`);
    return { excludeIds: [currentUserId], userInterests: [], userCity: null, userLat: null, userLng: null };
  }

  const myBlockedIds = currentUser.blockedUsers || [];
  const usersWhoBlockedMe = await User.find({ blockedUsers: currentUserId }, { _id: 1 });
  const blockedMeIds = usersWhoBlockedMe.map(u => u._id);

  const excludeIds    = [currentUserId, ...myBlockedIds, ...blockedMeIds];
  const userInterests = currentUser.questionnaire?.hangoutPreferences || [];

  // ── LOCATION PRIORITY ─────────────────────────────────────────────────────
  // 1. liveLocation.city  — set by MatchmakingLocationManager (GPS-based, fresh)
  // 2. questionnaire.city — static onboarding data (fallback)
  const liveCity         = currentUser.liveLocation?.city?.trim().toLowerCase() || null;
  const profileCity      = currentUser.questionnaire?.city?.trim().toLowerCase() || null;
  const userCity         = liveCity || profileCity;

  const userLat = currentUser.liveLocation?.lat ?? currentUser.last_known_lat ?? null;
  const userLng = currentUser.liveLocation?.lng ?? currentUser.last_known_lng ?? null;

  console.log(`[DB] getExcludeIds — userId=${currentUserId} | liveCity="${liveCity}" | profileCity="${profileCity}" | resolvedCity="${userCity}" | lat=${userLat} lng=${userLng}`);

  return { excludeIds, userInterests, userCity, userLat, userLng };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/spotlight
// ─────────────────────────────────────────────────────────────────────────────
exports.getSpotlightCompanions = async (req, res) => {
  const userId = req.userId;
  console.log(`[REQUEST] GET /spotlight — userId=${userId} query=${JSON.stringify(req.query)}`);

  try {
    const {
      interests,
      minRating,
      verifiedOnly,
      limit = 20,
      page  = 1
    } = req.query;

    // city/state from query params are IGNORED — we always use liveLocation.city
    // so the filter is always the user's real-time location, not stale client data.

    const { excludeIds, userInterests, userCity, userLat, userLng } = await getExcludeIds(userId);

    // ── Base filter ───────────────────────────────────────────────────────────
    const filter = {
      _id:          { $nin: excludeIds },
      userType:     'COMPANION',
      status:       'ACTIVE',
      hostActive:   true,
      profilePhoto: { $ne: null }
    };

    // ── City filter: prefer liveLocation.city, fallback questionnaire.city ────
    // We filter companions who live in or are currently in the same city as the
    // requesting user. Companions may not have liveLocation yet, so we check both.
    if (userCity) {
      const cityRegex = { $regex: new RegExp(`^${userCity}$`, 'i') };
      filter.$or = [
        { 'liveLocation.city':  cityRegex },
        { 'questionnaire.city': cityRegex },
      ];
      console.log(`[DB] City filter: "${userCity}" (via liveLocation or questionnaire)`);
    }

    if (interests) {
      const arr = interests.split(',').map(i => i.trim());
      filter['questionnaire.interests'] = { $in: arr };
    }
    if (verifiedOnly === 'true') filter.photoVerificationStatus = 'approved';
    if (minRating)    filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };

    console.log(`[DB] Spotlight filter: ${JSON.stringify(filter)}`);

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // ── Query with geo sort if we have coordinates ────────────────────────────
    // If the user has live GPS coords, sort companions by their liveLocation distance.
    // Otherwise fall back to: premium → rating → lastActive.
    let companionsQuery = User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType photoVerificationStatus liveLocation');

    if (userLat !== null && userLng !== null) {
      // Geo sort: companions with live location near the user come first
      // Since we can't do $nearSphere without a 2dsphere index on a sub-document,
      // we fetch and sort in JS. This is safe for ≤200 companions.
      companionsQuery = companionsQuery.sort({ isPremium: -1, 'ratingStats.averageRating': -1, lastActive: -1 });
    } else {
      companionsQuery = companionsQuery.sort({ isPremium: -1, 'ratingStats.averageRating': -1, lastActive: -1 });
    }

    const [allCompanions, totalCompanions] = await Promise.all([
      companionsQuery.limit(parseInt(limit) + 50).lean(), // fetch extra for geo re-sort
      User.countDocuments(filter)
    ]);

    // ── If we have coords, re-sort by actual distance ─────────────────────────
    let companions = allCompanions;
    if (userLat !== null && userLng !== null && companions.length > 1) {
      const haversine = (lat1, lng1, lat2, lng2) => {
        const R  = 6371;
        const dL = (lat2 - lat1) * Math.PI / 180;
        const dl = (lng2 - lng1) * Math.PI / 180;
        const a  = Math.sin(dL / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) *
                   Math.cos(lat2 * Math.PI / 180) * Math.sin(dl / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      companions = companions
        .map(c => {
          const cLat = c.liveLocation?.lat ?? null;
          const cLng = c.liveLocation?.lng ?? null;
          const distKm = (cLat !== null && cLng !== null)
            ? haversine(userLat, userLng, cLat, cLng)
            : 9999;
          return { ...c, _distKm: distKm };
        })
        .sort((a, b) => {
          // Premium always first within distance bands
          if (a.isPremium !== b.isPremium) return (b.isPremium ? 1 : 0) - (a.isPremium ? 1 : 0);
          return a._distKm - b._distKm;
        })
        .slice(skip, skip + parseInt(limit));
    } else {
      companions = companions.slice(skip, skip + parseInt(limit));
    }

    console.log(`[DB] Spotlight query → found=${companions.length} total=${totalCompanions}`);

    if (companions.length === 0) {
      console.warn(`[DB] ⚠️ Zero companions. Check: userType=COMPANION, status=ACTIVE, hostActive=true, city matches "${userCity}"`);
    }

    // ── Format ────────────────────────────────────────────────────────────────
    const formattedCompanions = companions.map(companion => {
      const companionInterests = companion.questionnaire?.hangoutPreferences || [];
      const overlapCount = userInterests.filter(i => companionInterests.includes(i)).length;

      // Distance label — shown in card
      const distKm = companion._distKm;
      const distanceLabel = (!distKm || distKm >= 9999) ? null
        : distKm < 1 ? '< 1 km away'
        : `${distKm.toFixed(1)} km away`;

      return {
        id:                     companion._id.toString(),
        name:                   `${companion.firstName || ''} ${companion.lastName || ''}`.trim(),
        profilePhoto:           companion.profilePhoto || null,
        verified:               companion.photoVerificationStatus === 'approved',
        isPremium:              companion.isPremium     || false,
        userType:               companion.userType,
        photoVerificationStatus: companion.photoVerificationStatus || null,
        sharedHangouts:         companionInterests,
        overlapCount,
        distanceLabel,                                         // NEW
        bio:                    companion.questionnaire?.bio              || null,
        tagline:                companion.questionnaire?.tagline          || null,
        price:                  companion.questionnaire?.price            || null,
        availability:           companion.questionnaire?.availability     || null,
        availableTimes:         companion.questionnaire?.availableTimes   || null,
        city:                   companion.liveLocation?.city || companion.questionnaire?.city || null,
        state:                  companion.liveLocation?.state || companion.questionnaire?.state || null,
        languagePreference:     companion.questionnaire?.languagePreference || null,
        comfortZones:           companion.questionnaire?.comfortZones     || null,
        vibeWords:              companion.questionnaire?.vibeWords        || null,
        openFor:                companion.questionnaire?.openFor          || null,
        averageRating:          companion.ratingStats?.averageRating      || 0,
        totalRatings:           companion.ratingStats?.totalRatings       || 0,
        completedBookings:      companion.ratingStats?.completedBookings  || 0
      };
    });

    const totalPages = Math.ceil(totalCompanions / parseInt(limit));
    console.log(`[RESPONSE] GET /spotlight → success=true companions=${formattedCompanions.length}`);

    return res.json({
      success:    true,
      companions: formattedCompanions,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCompanions,
        hasMore: parseInt(page) < totalPages
      }
    });

  } catch (error) {
    console.error(`[ERROR] GET /spotlight — userId=${userId} — ${error.message}`, error);
    return res.status(500).json({ success: false, message: 'Failed to fetch companions', companions: [] });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/spotlight/:companionId
// ─────────────────────────────────────────────────────────────────────────────
exports.getCompanionDetails = async (req, res) => {
  const userId      = req.userId;
  const companionId = req.params.companionId;
  console.log(`[REQUEST] GET /spotlight/${companionId} — userId=${userId}`);

  try {
    const { excludeIds, userInterests } = await getExcludeIds(userId);

    if (excludeIds.map(id => id.toString()).includes(companionId)) {
      return res.status(403).json({ success: false, message: 'Profile not available' });
    }

    const companion = await User.findOne({
      _id: companionId, userType: 'COMPANION', status: 'ACTIVE'
    }).select('-password -emailVerificationOTP -fcmTokens');

    if (!companion) {
      return res.status(404).json({ success: false, message: 'Companion not found' });
    }

    const companionInterests = companion.questionnaire?.hangoutPreferences || [];
    const overlapCount = userInterests.filter(i => companionInterests.includes(i)).length;

    return res.json({
      success: true,
      companion: {
        id:                     companion._id.toString(),
        name:                   `${companion.firstName || ''} ${companion.lastName || ''}`.trim(),
        profilePhoto:           companion.profilePhoto || null,
        verified:               companion.photoVerificationStatus === 'approved',
        isPremium:              companion.isPremium     || false,
        userType:               companion.userType,
        photoVerificationStatus: companion.photoVerificationStatus || null,
        sharedHangouts:         companionInterests,
        overlapCount,
        bio:                    companion.questionnaire?.bio              || null,
        tagline:                companion.questionnaire?.tagline          || null,
        price:                  companion.questionnaire?.price            || null,
        availability:           companion.questionnaire?.availability     || null,
        availableTimes:         companion.questionnaire?.availableTimes   || null,
        city:                   companion.liveLocation?.city || companion.questionnaire?.city || null,
        state:                  companion.liveLocation?.state || companion.questionnaire?.state || null,
        languagePreference:     companion.questionnaire?.languagePreference || null,
        comfortZones:           companion.questionnaire?.comfortZones     || null,
        vibeWords:              companion.questionnaire?.vibeWords        || null,
        openFor:                companion.questionnaire?.openFor          || null,
        averageRating:          companion.ratingStats?.averageRating      || 0,
        totalRatings:           companion.ratingStats?.totalRatings       || 0,
        completedBookings:      companion.ratingStats?.completedBookings  || 0
      }
    });

  } catch (error) {
    console.error(`[ERROR] GET /spotlight/${companionId} — ${error.message}`, error);
    return res.status(500).json({ success: false, message: 'Failed to fetch companion details' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/spotlight/search
// ─────────────────────────────────────────────────────────────────────────────
exports.searchCompanions = async (req, res) => {
  const userId = req.userId;
  console.log(`[REQUEST] GET /spotlight/search — userId=${userId} query=${JSON.stringify(req.query)}`);

  try {
    const {
      query, city, state, minPrice, maxPrice,
      availability, interests, minRating,
      limit = 20
    } = req.query;

    const { excludeIds, userInterests, userCity } = await getExcludeIds(userId);

    const filter = {
      _id:        { $nin: excludeIds },
      userType:   'COMPANION',
      status:     'ACTIVE',
      hostActive: true
    };

    if (query) {
      filter.$or = [
        { firstName:               { $regex: query, $options: 'i' } },
        { lastName:                { $regex: query, $options: 'i' } },
        { 'questionnaire.tagline': { $regex: query, $options: 'i' } },
        { 'questionnaire.bio':     { $regex: query, $options: 'i' } }
      ];
    }

    // Explicit city param from client (search UI) takes priority; else use live city
    const effectiveCity = city?.trim() || userCity;
    if (effectiveCity) {
      const cityRegex = { $regex: new RegExp(`^${effectiveCity}$`, 'i') };
      if (!filter.$or) filter.$or = [];
      // Don't override text $or — use $and if we already have $or
      if (filter.$or.length > 0) {
        filter.$and = [
          { $or: filter.$or },
          { $or: [{ 'liveLocation.city': cityRegex }, { 'questionnaire.city': cityRegex }] }
        ];
        delete filter.$or;
      } else {
        filter.$or = [{ 'liveLocation.city': cityRegex }, { 'questionnaire.city': cityRegex }];
      }
    }

    if (state)        filter['questionnaire.state']        = state;
    if (availability) filter['questionnaire.availability'] = availability;
    if (interests) {
      filter['questionnaire.hangoutPreferences'] = { $in: interests.split(',').map(i => i.trim()) };
    }
    if (minRating) filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium photoVerificationStatus liveLocation')
      .sort({ 'ratingStats.averageRating': -1, lastActive: -1 })
      .limit(parseInt(limit))
      .lean();

    const formattedCompanions = companions.map(companion => {
      const companionInterests = companion.questionnaire?.hangoutPreferences || [];
      const overlapCount = userInterests.filter(i => companionInterests.includes(i)).length;
      return {
        id:                     companion._id.toString(),
        name:                   `${companion.firstName || ''} ${companion.lastName || ''}`.trim(),
        profilePhoto:           companion.profilePhoto || null,
        verified:               companion.photoVerificationStatus === 'approved',
        isPremium:              companion.isPremium     || false,
        photoVerificationStatus: companion.photoVerificationStatus || null,
        sharedHangouts:         companionInterests,
        overlapCount,
        bio:                    companion.questionnaire?.bio    || null,
        tagline:                companion.questionnaire?.tagline || null,
        price:                  companion.questionnaire?.price  || null,
        city:                   companion.liveLocation?.city || companion.questionnaire?.city || null,
        state:                  companion.liveLocation?.state || companion.questionnaire?.state || null,
        averageRating:          companion.ratingStats?.averageRating || 0,
        totalRatings:           companion.ratingStats?.totalRatings  || 0
      };
    });

    console.log(`[RESPONSE] GET /spotlight/search → success=true count=${formattedCompanions.length}`);
    return res.json({ success: true, companions: formattedCompanions, count: formattedCompanions.length });

  } catch (error) {
    console.error(`[ERROR] GET /spotlight/search — ${error.message}`, error);
    return res.status(500).json({ success: false, message: 'Search failed', companions: [] });
  }
};
