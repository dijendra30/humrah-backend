// controllers/spotlight.controller.js - WITH FALLBACK DATA FOR NEW USERS
const User = require('../models/User');

/**
 * @route   GET /api/spotlight
 * @desc    Get personalized companion recommendations with fallback data
 * @access  Private
 */
exports.getSpotlightCompanions = async (req, res) => {
  try {
    const currentUserId = req.userId;

    console.log('🔍 Spotlight request from user:', currentUserId);

    // 1. Fetch current user
    const currentUser = await User.findById(currentUserId)
      .select('firstName lastName questionnaire role');
    
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

    // 3. Fetch companions - ✅ ONLY USER ROLE (excludes admins)
    const eligibleCompanions = await User.find({
      _id: { $ne: currentUserId },
      role: 'USER', // ✅ CRITICAL FIX: Only match USER role
      verified: true
    })
    .select('_id firstName lastName profilePhoto verified photoVerificationStatus questionnaire')
    .limit(50);

    console.log(`📊 Found ${eligibleCompanions.length} eligible companions`);

    // 4. Calculate shared hangouts & add fallback data
    const companionsWithOverlap = eligibleCompanions.map(companion => {
      const companionHangouts = companion.questionnaire?.hangoutPreferences || [];
      const sharedHangouts = userHangouts.filter(hangout => 
        companionHangouts.includes(hangout)
      );
      const overlapCount = sharedHangouts.length;

      // ✅ LOG: Check what data exists
      const hasBio = !!companion.questionnaire?.bio;
      const hasTagline = !!companion.questionnaire?.tagline;
      const hasVibeWords = (companion.questionnaire?.vibeWords?.length || 0) > 0;
      
      console.log(`📦 ${companion.firstName}: bio=${hasBio}, tagline=${hasTagline}, vibes=${hasVibeWords}`);

      return {
  id: user._id.toString(),
  name: `${user.firstName} ${user.lastName}`,
  profilePhoto: user.profilePhoto,
  
  // ✅ ADD ALL MISSING FIELDS
  bio: user.questionnaire?.bio,
  tagline: user.questionnaire?.tagline,
  sharedHangouts: sharedHangouts.length > 0 ? sharedHangouts,
  overlapCount: sharedHangouts.length,
  vibeWords: user.questionnaire?.vibeWords?.length > 0 
    ? user.questionnaire.vibeWords,
  city: user.questionnaire?.city,
  state: user.questionnaire?.state,
  availableTimes: user.questionnaire?.availableTimes,
  languagePreference: user.questionnaire?.languagePreference,
  comfortZones: user.questionnaire?.comfortZones,
  becomeCompanion: user.questionnaire?.becomeCompanion,
  price: user.questionnaire?.price,
  photoVerificationStatus: user.photoVerificationStatus'
};
    });

    // 5. Sort by overlap count
    companionsWithOverlap.sort((a, b) => b.overlapCount - a.overlapCount);

    // 6. Take top 10
    const topCompanions = companionsWithOverlap.slice(0, 10);

    console.log(`✅ Returning ${topCompanions.length} companions`);
    console.log('👤 Companions:', topCompanions.map(c => ({ 
      name: c.name, 
      overlap: c.overlapCount,
      hasBio: c.bio !== "New user exploring Humrah! Say hi and see what we have in common 👋"
    })));

    // 7. Return as 'companions' (NOT 'data' - Android compatibility)
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
