// controllers/spotlight.controller.js - FIXED with correct Android field mapping
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// ✅ BLOCK FILTERING HELPER (Prompt §12)
// Returns IDs to exclude from every discovery query:
//   • self
//   • users I blocked
//   • users who blocked me
// Also returns current user's hangout interests for overlap calculation.
// ─────────────────────────────────────────────────────────────────────────────
async function getExcludeIds(currentUserId) {
  // Fetch my blockedUsers list AND questionnaire in one query
  const currentUser = await User.findById(currentUserId)
    .select('questionnaire blockedUsers');

  const myBlockedIds = currentUser?.blockedUsers || [];

  // Find users who have blocked me
  const usersWhoBlockedMe = await User.find(
    { blockedUsers: currentUserId },
    { _id: 1 }
  );
  const blockedMeIds = usersWhoBlockedMe.map(u => u._id);

  return {
    excludeIds:    [currentUserId, ...myBlockedIds, ...blockedMeIds],
    userInterests: currentUser?.questionnaire?.hangoutPreferences || []
  };
}

/**
 * Get spotlight companions
 * 
 * ✅ FIXED: Correct field mapping for Android app
 * - id (not _id)
 * - name (combined firstName + lastName)
 * - sharedHangouts (interests)
 * - overlapCount (calculated based on matching interests)
 */
exports.getSpotlightCompanions = async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { 
      city, 
      state,
      interests,
      minRating,
      verifiedOnly,
      limit = 20,
      page = 1 
    } = req.query;

    // ✅ §12: get blocked/blocker IDs + current user interests in one helper call
    // (replaces the previous single User.findById that only fetched questionnaire)
    const { excludeIds, userInterests } = await getExcludeIds(currentUserId);

    // ✅ BASE FILTER: Only COMPANION users who are actively hosting
    const filter = {
      _id: { $nin: excludeIds }, // ✅ §12: was $ne — now excludes blocked + blockers
      userType: 'COMPANION',
      status: 'ACTIVE',
      hostActive: true,   // ✅ FIX: exclude hosts who paused their hosting
      profilePhoto: { $ne: null }
    };

    // Additional filters
    if (city) {
      filter['questionnaire.city'] = city;
    }

    if (state) {
      filter['questionnaire.state'] = state;
    }

    if (interests) {
      const interestArray = interests.split(',').map(i => i.trim());
      filter['questionnaire.interests'] = { $in: interestArray };
    }

    if (verifiedOnly === 'true') {
      filter.photoVerificationStatus = 'approved';
    }

    if (minRating) {
      filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Query companions
    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType photoVerificationStatus')
      .sort({ 
        isPremium: -1,
        'ratingStats.averageRating': -1,
        lastActive: -1
      })
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count
    const totalCompanions = await User.countDocuments(filter);
    const totalPages = Math.ceil(totalCompanions / parseInt(limit));

    // ✅ FIXED: Format response with correct field names for Android
    const formattedCompanions = companions.map(companion => {
      // Calculate overlap count
      const companionInterests = companion.questionnaire?.hangoutPreferences || [];
      const overlapCount = userInterests.filter(interest => 
        companionInterests.includes(interest)
      ).length;

      return {
        // ✅ FIX: Use 'id' not '_id'
        id: companion._id.toString(),
        
        // ✅ FIX: Combine firstName + lastName into 'name'
        name: `${companion.firstName} ${companion.lastName}`.trim(),
        
        profilePhoto: companion.profilePhoto,
        verified: companion.verified,
        isPremium: companion.isPremium,
        userType: companion.userType,
        photoVerificationStatus: companion.photoVerificationStatus,
        
        // ✅ FIX: Use 'sharedHangouts' for interests
        sharedHangouts: companionInterests,
        
        // ✅ FIX: Calculate and include overlapCount
        overlapCount: overlapCount,
        
        // Companion details from questionnaire
        bio: companion.questionnaire?.bio || null,
        tagline: companion.questionnaire?.tagline || null,
        price: companion.questionnaire?.price || null,
        availability: companion.questionnaire?.availability || null,
        availableTimes: companion.questionnaire?.availableTimes || null,
        city: companion.questionnaire?.city || null,
        state: companion.questionnaire?.state || null,
        languagePreference: companion.questionnaire?.languagePreference || null,
        comfortZones: companion.questionnaire?.comfortZones || null,
        vibeWords: companion.questionnaire?.vibeWords || null,
        openFor: companion.questionnaire?.openFor || null,
        
        // Ratings
        averageRating: companion.ratingStats?.averageRating || 0,
        totalRatings: companion.ratingStats?.totalRatings || 0,
        completedBookings: companion.ratingStats?.completedBookings || 0
      };
    });

    res.json({
      success: true,
      companions: formattedCompanions,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCompanions,
        hasMore: parseInt(page) < totalPages
      }
    });

  } catch (error) {
    console.error('Get spotlight companions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch companions'
    });
  }
};

/**
 * Get companion details by ID
 */
exports.getCompanionDetails = async (req, res) => {
  try {
    const currentUserId   = req.userId;
    const { companionId } = req.params;

    // ✅ §12: refuse if requester and companion have blocked each other
    const { excludeIds, userInterests } = await getExcludeIds(currentUserId);
    if (excludeIds.map(id => id.toString()).includes(companionId)) {
      return res.status(403).json({
        success: false,
        message: 'Profile not available'
      });
    }

    const companion = await User.findOne({
      _id: companionId,
      userType: 'COMPANION',
      status: 'ACTIVE'
    }).select('-password -emailVerificationOTP -fcmTokens');

    if (!companion) {
      return res.status(404).json({
        success: false,
        message: 'Companion not found'
      });
    }

    // ✅ FIXED: Format response correctly
    const companionInterests = companion.questionnaire?.hangoutPreferences || [];
    const overlapCount = userInterests.filter(i =>  // ✅ was hardcoded 0
      companionInterests.includes(i)
    ).length;

    const formattedCompanion = {
      id: companion._id.toString(),
      name: `${companion.firstName} ${companion.lastName}`.trim(),
      profilePhoto: companion.profilePhoto,
      verified: companion.verified,
      isPremium: companion.isPremium,
      userType: companion.userType,
      photoVerificationStatus: companion.photoVerificationStatus,
      
      sharedHangouts: companionInterests,
      overlapCount,  // ✅ now correctly calculated
      
      bio: companion.questionnaire?.bio || null,
      tagline: companion.questionnaire?.tagline || null,
      price: companion.questionnaire?.price || null,
      availability: companion.questionnaire?.availability || null,
      availableTimes: companion.questionnaire?.availableTimes || null,
      city: companion.questionnaire?.city || null,
      state: companion.questionnaire?.state || null,
      languagePreference: companion.questionnaire?.languagePreference || null,
      comfortZones: companion.questionnaire?.comfortZones || null,
      vibeWords: companion.questionnaire?.vibeWords || null,
      openFor: companion.questionnaire?.openFor || null,
      
      averageRating: companion.ratingStats?.averageRating || 0,
      totalRatings: companion.ratingStats?.totalRatings || 0,
      completedBookings: companion.ratingStats?.completedBookings || 0
    };

    res.json({
      success: true,
      companion: formattedCompanion
    });

  } catch (error) {
    console.error('Get companion details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch companion details'
    });
  }
};

/**
 * Search companions with filters
 */
exports.searchCompanions = async (req, res) => {
  try {
    const { 
      query,
      city,
      state,
      minPrice,
      maxPrice,
      availability,
      interests,
      minRating,
      limit = 20 
    } = req.query;

    // ✅ §12: get blocked/blocker IDs + current user interests in one helper call
    const { excludeIds, userInterests } = await getExcludeIds(req.userId);

    const filter = {
      _id: { $nin: excludeIds }, // ✅ §12: was $ne — now excludes blocked + blockers
      userType: 'COMPANION',
      status: 'ACTIVE',
      hostActive: true   // ✅ FIX: exclude paused hosts from search
    };

    // Text search
    if (query) {
      filter.$or = [
        { firstName: { $regex: query, $options: 'i' } },
        { lastName: { $regex: query, $options: 'i' } },
        { 'questionnaire.tagline': { $regex: query, $options: 'i' } },
        { 'questionnaire.bio': { $regex: query, $options: 'i' } }
      ];
    }

    // Location filters
    if (city) filter['questionnaire.city'] = city;
    if (state) filter['questionnaire.state'] = state;

    // Availability
    if (availability) {
      filter['questionnaire.availability'] = availability;
    }

    // Interests
    if (interests) {
      const interestArray = interests.split(',');
      filter['questionnaire.hangoutPreferences'] = { $in: interestArray };
    }

    // Rating
    if (minRating) {
      filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };
    }

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium photoVerificationStatus')
      .sort({ 'ratingStats.averageRating': -1, lastActive: -1 })
      .limit(parseInt(limit));

    // ✅ FIXED: Format response correctly
    const formattedCompanions = companions.map(companion => {
      const companionInterests = companion.questionnaire?.hangoutPreferences || [];
      const overlapCount = userInterests.filter(interest => 
        companionInterests.includes(interest)
      ).length;

      return {
        id: companion._id.toString(),
        name: `${companion.firstName} ${companion.lastName}`.trim(),
        profilePhoto: companion.profilePhoto,
        verified: companion.verified,
        isPremium: companion.isPremium,
        photoVerificationStatus: companion.photoVerificationStatus,
        sharedHangouts: companionInterests,
        overlapCount: overlapCount,
        bio: companion.questionnaire?.bio || null,
        tagline: companion.questionnaire?.tagline || null,
        price: companion.questionnaire?.price || null,
        city: companion.questionnaire?.city || null,
        state: companion.questionnaire?.state || null,
        averageRating: companion.ratingStats?.averageRating || 0,
        totalRatings: companion.ratingStats?.totalRatings || 0
      };
    });

    res.json({
      success: true,
      companions: formattedCompanions,
      count: formattedCompanions.length
    });

  } catch (error) {
    console.error('Search companions error:', error);
    res.status(500).json({
      success: false,
      message: 'Search failed'
    });
  }
};
