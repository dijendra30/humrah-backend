// controllers/spotlight.controller.js - SHOW REAL USER DATA
const User = require('../models/User');

/**
 * @route   GET /api/spotlight
 * @desc    Get real companion data based on shared hangout preferences
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
      city: currentUser.questionnaire?.city,
      role: currentUser.role
    });

    // 2. Get user's hangout preferences
    const userHangouts = currentUser.questionnaire?.hangoutPreferences || [];
    const userCity = currentUser.questionnaire?.city;

    console.log('🎯 User preferences:', {
      hangouts: userHangouts,
      city: userCity
    });

    // 3. Build query - ✅ ONLY USER ROLE, prefer same city
    const query = {
      _id: { $ne: currentUserId },
      role: 'USER', // ✅ ONLY match USER role (excludes SAFETY_ADMIN, SUPER_ADMIN)
      verified: true
    };

    // Prefer users in same city (but don't make it mandatory)
    if (userCity) {
      query['questionnaire.city'] = userCity;
    }

    console.log('🔎 Query:', JSON.stringify(query, null, 2));

    // 4. Fetch companions
    let eligibleCompanions = await User.find(query)
      .select('_id firstName lastName profilePhoto verified photoVerificationStatus questionnaire')
      .limit(50);

    console.log(`📊 Found ${eligibleCompanions.length} companions in same city`);

    // 5. Fallback: If no users in same city, get any users
    if (eligibleCompanions.length === 0) {
      console.log('🔄 No companions in same city, fetching from all cities...');
      
      eligibleCompanions = await User.find({
        _id: { $ne: currentUserId },
        role: 'USER',
        verified: true
      })
      .select('_id firstName lastName profilePhoto verified photoVerificationStatus questionnaire')
      .limit(50);
      
      console.log(`📊 Found ${eligibleCompanions.length} companions total`);
    }

    // 6. Calculate shared hangouts and map data
    const companionsWithOverlap = eligibleCompanions.map(companion => {
      const q = companion.questionnaire || {};
      
      // Calculate shared hangouts
      const companionHangouts = q.hangoutPreferences || [];
      const sharedHangouts = userHangouts.filter(hangout => 
        companionHangouts.includes(hangout)
      );
      const overlapCount = sharedHangouts.length;

      // ✅ LOG: Show what data exists for this user
      console.log(`📦 ${companion.firstName}:`, {
        hasName: !!q.name,
        hasCity: !!q.city,
        hasBio: !!q.bio,
        hasTagline: !!q.tagline,
        hangoutsCount: companionHangouts.length,
        sharedCount: sharedHangouts.length,
        hasVibeWords: (q.vibeWords?.length || 0) > 0
      });

      // ✅ RETURN REAL USER DATA (exactly as stored)
      return {
        id: companion._id.toString(),
        name: `${companion.firstName} ${companion.lastName}`.trim(),
        profilePhoto: companion.profilePhoto || null,
        
        // ✅ REAL DATA: Show what user actually filled (null if empty)
        bio: q.bio || null,
        tagline: q.tagline || null,
        
        // ✅ SHARED HANGOUTS: Only show if there are matches
        sharedHangouts: sharedHangouts.length > 0 ? sharedHangouts : [],
        overlapCount,
        
        // ✅ REAL DATA: Arrays (empty if not filled)
        vibeWords: q.vibeWords || [],
        
        // ✅ REAL DATA: Location
        city: q.city || null,
        state: q.state || null,
        
        // ✅ REAL DATA: Availability
        availableTimes: q.availableTimes || [],
        languagePreference: q.languagePreference || null,
        
        // ✅ REAL DATA: Comfort zones
        comfortZones: q.comfortZones || [],
        
        // ✅ COMPANION MODE: Real data
        becomeCompanion: q.becomeCompanion || null,
        price: q.price || null,
        
        // ✅ VERIFICATION STATUS
        photoVerificationStatus: companion.photoVerificationStatus || 'not_submitted'
      };
    });

    // 7. Sort by overlap count (users with shared interests first)
    companionsWithOverlap.sort((a, b) => b.overlapCount - a.overlapCount);

    // 8. Take top 10
    const topCompanions = companionsWithOverlap.slice(0, 10);

    console.log(`✅ Returning ${topCompanions.length} companions`);
    console.log('👤 Companions:', topCompanions.map(c => ({ 
      name: c.name, 
      city: c.city,
      overlap: c.overlapCount,
      hasBio: !!c.bio,
      hasVibeWords: c.vibeWords.length > 0
    })));

    // 9. ✅ Return as 'companions' (NOT 'data' - for Android compatibility)
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
