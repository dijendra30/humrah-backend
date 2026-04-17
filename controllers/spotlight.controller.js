// controllers/spotlight.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// Hardened with structured [REQUEST] / [DB] / [RESPONSE] logging.
// Every filter value is printed so you can see exactly why companions are
// included or excluded.  Remove or gate behind NODE_ENV before shipping to prod.
// ─────────────────────────────────────────────────────────────────────────────
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK FILTERING HELPER
// Returns IDs to exclude from every discovery query:
//   • self  •  users I blocked  •  users who blocked me
// Also returns current user's hangout interests for overlap calculation.
// ─────────────────────────────────────────────────────────────────────────────
async function getExcludeIds(currentUserId) {
  const currentUser = await User.findById(currentUserId)
    .select('questionnaire blockedUsers');

  if (!currentUser) {
    console.warn(`[DB] getExcludeIds — user ${currentUserId} not found`);
    return { excludeIds: [currentUserId], userInterests: [] };
  }

  const myBlockedIds = currentUser.blockedUsers || [];

  const usersWhoBlockedMe = await User.find(
    { blockedUsers: currentUserId },
    { _id: 1 }
  );
  const blockedMeIds = usersWhoBlockedMe.map(u => u._id);

  const excludeIds   = [currentUserId, ...myBlockedIds, ...blockedMeIds];
  const userInterests = currentUser.questionnaire?.hangoutPreferences || [];

  console.log(`[DB] getExcludeIds — userId=${currentUserId} | blocked=${myBlockedIds.length} | blockedBy=${blockedMeIds.length} | interests=${userInterests.length}`);

  return { excludeIds, userInterests };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/spotlight
// ─────────────────────────────────────────────────────────────────────────────
exports.getSpotlightCompanions = async (req, res) => {
  const userId = req.userId;
  console.log(`[REQUEST] GET /spotlight — userId=${userId} query=${JSON.stringify(req.query)}`);

  try {
    const {
      city,
      state,
      interests,
      minRating,
      verifiedOnly,
      limit = 20,
      page  = 1
    } = req.query;

    const { excludeIds, userInterests } = await getExcludeIds(userId);

    // ── Base filter ───────────────────────────────────────────────────────────
    const filter = {
      _id:          { $nin: excludeIds },
      userType:     'COMPANION',
      status:       'ACTIVE',
      hostActive:   true,
      profilePhoto: { $ne: null }
    };

    // ── Optional filters ──────────────────────────────────────────────────────
    if (city)         filter['questionnaire.city']  = city;
    if (state)        filter['questionnaire.state'] = state;
    if (interests) {
      const arr = interests.split(',').map(i => i.trim());
      filter['questionnaire.interests'] = { $in: arr };
    }
    if (verifiedOnly === 'true') filter.photoVerificationStatus = 'approved';
    if (minRating)    filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };

    console.log(`[DB] Spotlight filter: ${JSON.stringify(filter)}`);

    // ── Query ─────────────────────────────────────────────────────────────────
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [companions, totalCompanions] = await Promise.all([
      User.find(filter)
        .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType photoVerificationStatus')
        .sort({ isPremium: -1, 'ratingStats.averageRating': -1, lastActive: -1 })
        .limit(parseInt(limit))
        .skip(skip),
      User.countDocuments(filter)
    ]);

    console.log(`[DB] Spotlight query → found=${companions.length} total=${totalCompanions}`);

    if (companions.length === 0) {
      console.warn(`[DB] ⚠️  Zero companions returned. Debug checklist:`);
      console.warn(`        1. Any user with userType='COMPANION' AND status='ACTIVE' AND hostActive=true AND profilePhoto≠null?`);
      console.warn(`        2. Run: db.users.countDocuments({userType:'COMPANION',status:'ACTIVE',hostActive:true}) in Mongo shell`);
    }

    // ── Format ────────────────────────────────────────────────────────────────
    const formattedCompanions = companions.map(companion => {
      const companionInterests = companion.questionnaire?.hangoutPreferences || [];
      const overlapCount = userInterests.filter(i => companionInterests.includes(i)).length;

      return {
        id:                     companion._id.toString(),
        name:                   `${companion.firstName || ''} ${companion.lastName || ''}`.trim(),
        profilePhoto:           companion.profilePhoto || null,
        verified:               companion.verified     || false,
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
        city:                   companion.questionnaire?.city             || null,
        state:                  companion.questionnaire?.state            || null,
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

    console.log(`[RESPONSE] GET /spotlight → success=true companions=${formattedCompanions.length} totalPages=${totalPages}`);

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
    return res.status(500).json({
      success:  false,
      message:  'Failed to fetch companions',
      companions: []   // always return the array key so Android never NPEs
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/spotlight/:companionId
// ─────────────────────────────────────────────────────────────────────────────
exports.getCompanionDetails = async (req, res) => {
  const userId       = req.userId;
  const companionId  = req.params.companionId;
  console.log(`[REQUEST] GET /spotlight/${companionId} — userId=${userId}`);

  try {
    const { excludeIds, userInterests } = await getExcludeIds(userId);

    if (excludeIds.map(id => id.toString()).includes(companionId)) {
      console.warn(`[DB] Companion ${companionId} is blocked by/blocks user ${userId}`);
      return res.status(403).json({ success: false, message: 'Profile not available' });
    }

    const companion = await User.findOne({
      _id:      companionId,
      userType: 'COMPANION',
      status:   'ACTIVE'
    }).select('-password -emailVerificationOTP -fcmTokens');

    if (!companion) {
      console.warn(`[DB] Companion ${companionId} not found`);
      return res.status(404).json({ success: false, message: 'Companion not found' });
    }

    const companionInterests = companion.questionnaire?.hangoutPreferences || [];
    const overlapCount = userInterests.filter(i => companionInterests.includes(i)).length;

    const formattedCompanion = {
      id:                     companion._id.toString(),
      name:                   `${companion.firstName || ''} ${companion.lastName || ''}`.trim(),
      profilePhoto:           companion.profilePhoto || null,
      verified:               companion.verified     || false,
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
      city:                   companion.questionnaire?.city             || null,
      state:                  companion.questionnaire?.state            || null,
      languagePreference:     companion.questionnaire?.languagePreference || null,
      comfortZones:           companion.questionnaire?.comfortZones     || null,
      vibeWords:              companion.questionnaire?.vibeWords        || null,
      openFor:                companion.questionnaire?.openFor          || null,
      averageRating:          companion.ratingStats?.averageRating      || 0,
      totalRatings:           companion.ratingStats?.totalRatings       || 0,
      completedBookings:      companion.ratingStats?.completedBookings  || 0
    };

    console.log(`[RESPONSE] GET /spotlight/${companionId} → success=true`);
    return res.json({ success: true, companion: formattedCompanion });

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

    const { excludeIds, userInterests } = await getExcludeIds(userId);

    const filter = {
      _id:        { $nin: excludeIds },
      userType:   'COMPANION',
      status:     'ACTIVE',
      hostActive: true
    };

    if (query) {
      filter.$or = [
        { firstName:                   { $regex: query, $options: 'i' } },
        { lastName:                    { $regex: query, $options: 'i' } },
        { 'questionnaire.tagline':     { $regex: query, $options: 'i' } },
        { 'questionnaire.bio':         { $regex: query, $options: 'i' } }
      ];
    }
    if (city)         filter['questionnaire.city']         = city;
    if (state)        filter['questionnaire.state']        = state;
    if (availability) filter['questionnaire.availability'] = availability;
    if (interests) {
      filter['questionnaire.hangoutPreferences'] = {
        $in: interests.split(',').map(i => i.trim())
      };
    }
    if (minRating) filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };

    console.log(`[DB] searchCompanions filter: ${JSON.stringify(filter)}`);

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium photoVerificationStatus')
      .sort({ 'ratingStats.averageRating': -1, lastActive: -1 })
      .limit(parseInt(limit));

    console.log(`[DB] searchCompanions → found=${companions.length}`);

    const formattedCompanions = companions.map(companion => {
      const companionInterests = companion.questionnaire?.hangoutPreferences || [];
      const overlapCount = userInterests.filter(i => companionInterests.includes(i)).length;
      return {
        id:                     companion._id.toString(),
        name:                   `${companion.firstName || ''} ${companion.lastName || ''}`.trim(),
        profilePhoto:           companion.profilePhoto || null,
        verified:               companion.verified     || false,
        isPremium:              companion.isPremium     || false,
        photoVerificationStatus: companion.photoVerificationStatus || null,
        sharedHangouts:         companionInterests,
        overlapCount,
        bio:                    companion.questionnaire?.bio    || null,
        tagline:                companion.questionnaire?.tagline || null,
        price:                  companion.questionnaire?.price  || null,
        city:                   companion.questionnaire?.city   || null,
        state:                  companion.questionnaire?.state  || null,
        averageRating:          companion.ratingStats?.averageRating || 0,
        totalRatings:           companion.ratingStats?.totalRatings  || 0
      };
    });

    console.log(`[RESPONSE] GET /spotlight/search → success=true count=${formattedCompanions.length}`);

    return res.json({
      success:    true,
      companions: formattedCompanions,
      count:      formattedCompanions.length
    });

  } catch (error) {
    console.error(`[ERROR] GET /spotlight/search — ${error.message}`, error);
    return res.status(500).json({
      success:    false,
      message:    'Search failed',
      companions: []
    });
  }
};
