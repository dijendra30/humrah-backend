// controllers/spotlight.controller.js - ABSOLUTELY FINAL FIX
const User = require('../models/User');

/**
 * @route   GET /api/spotlight
 * @desc    Get personalized companion recommendations based on shared hangout preferences
 * @access  Private (requires authentication)
 */
exports.getSpotlightCompanions = async (req, res) => {
  try {
    const currentUserId = req.userId;

    console.log('🔍 Spotlight request from user:', currentUserId);

    // 1. Fetch current user
    const currentUser = await User.findById(currentUserId).select('questionnaire role');
    
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log('✅ Current user:', {
      id: currentUser._id,
      name: `${currentUser.firstName} ${currentUser.lastName}`,
      role: currentUser.role
    });

    // 2. Get user's hangout preferences
    const userHangouts = currentUser.questionnaire?.hangoutPreferences || [];

    // 3. Build query - ✅ CRITICAL FIX: Only USER role
    const baseQuery = {
  _id: { $ne: currentUserId },
  role: 'USER',          // ✅ explicit allow-list
  status: 'ACTIVE',
  verified: true
};


    console.log('🔎 Query:', JSON.stringify(query, null, 2));

    // 4. Fetch companions
 const eligibleCompanions = await User.find({
  _id: { $ne: currentUserId },
  role: 'USER',            // 🚫 excludes SAFETY_ADMIN & SUPER_ADMIN
  verified: true,          // optional but recommended
  status: 'ACTIVE'
});

    
    // 5. Log roles for debugging
     console.log('👥 Final companions:', eligibleCompanions.map(c => ({
      id: c._id,
      name: `${c.firstName} ${c.lastName}`,
      role: c.role // This should log to verify
    })));
    // 6. Calculate shared hangouts
    const companionsWithOverlap = eligibleCompanions.map(companion => {
      const companionHangouts = companion.questionnaire?.hangoutPreferences || [];
      const sharedHangouts = userHangouts.filter(hangout => 
        companionHangouts.includes(hangout)
      );
      const overlapCount = sharedHangouts.length;

     return {
  id: companion._id.toString(),
  name: `${companion.firstName} ${companion.lastName}`.trim(),
  profilePhoto: companion.profilePhoto ?? null,

  sharedHangouts: sharedHangouts ?? [],
  overlapCount: overlapCount ?? 0,

  bio: companion.questionnaire?.bio ?? null,
  availability: companion.questionnaire?.availability ?? null,
  availableTimes: companion.questionnaire?.availableTimes ?? [],

  city: companion.questionnaire?.city ?? null,
  state: companion.questionnaire?.state ?? null,

  languagePreference: companion.questionnaire?.languagePreference ?? null,
  comfortZones: companion.questionnaire?.comfortZones ?? [],
  vibeWords: companion.questionnaire?.vibeWords ?? [],

  becomeCompanion: companion.questionnaire?.becomeCompanion ?? null,
  price: companion.questionnaire?.price ?? null,
  tagline: companion.questionnaire?.tagline ?? null,

  photoVerificationStatus: companion.photoVerificationStatus ?? "pending"
};

    });

    // 7. Sort by overlap
    companionsWithOverlap.sort((a, b) => b.overlapCount - a.overlapCount);

    // 8. Top 5
    const topCompanions = companionsWithOverlap.slice(0, 5);

    console.log(`✅ Returning ${topCompanions.length} companions`);
    console.log('👤 Companions:', topCompanions.map(c => ({ name: c.name, overlap: c.overlapCount })));

    // 9. ✅ Return as 'companions' not 'data' (for Android compatibility)
    res.status(200).json({
      success: true,
      count: topCompanions.length,
      companions: topCompanions
    });

  } catch (error) {
    console.error('❌ Spotlight error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch spotlight companions',
      error: error.message
    });
  }
};
