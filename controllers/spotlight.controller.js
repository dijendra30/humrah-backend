// controllers/spotlight.controller.js - SAME CITY ONLY
const User = require('../models/User');

/**
 * @route   GET /api/spotlight
 * @desc    Get companions in SAME CITY ONLY with real user data
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

    // 2. Get user's preferences
    const userHangouts = currentUser.questionnaire?.hangoutPreferences || [];
    const userCity = currentUser.questionnaire?.city;

    console.log('🎯 User preferences:', {
      hangouts: userHangouts,
      city: userCity
    });

    // 3. ✅ CHECK: If user has no city, return empty
    if (!userCity) {
      console.log('⚠️ User has no city set, returning empty companions');
      return res.status(200).json({
        success: true,
        count: 0,
        companions: [],
        message: 'Please set your city in profile to see companions'
      });
    }

    // 4. Fetch ALL user companions (we'll filter by city in JS)
    const query = {
      _id: { $ne: currentUserId },
      role: 'USER'
    };

    console.log('🔎 Query:', JSON.stringify(query, null, 2));

    const allCompanions = await User.find(query)
      .select('_id firstName lastName profilePhoto verified photoVerificationStatus questionnaire')
      .limit(100);

    console.log(`📊 Found ${allCompanions.length} total companions`);

    // 5. ✅ FILTER: Only companions in SAME CITY (case-insensitive)
    const sameCityCompanions = allCompanions.filter(companion => {
      const companionCity = companion.questionnaire?.city;
      return companionCity && 
             companionCity.toLowerCase().trim() === userCity.toLowerCase().trim();
    });

    console.log(`🏙️ Filtered to ${sameCityCompanions.length} companions in ${userCity}`);

    // 6. ✅ CHECK: If no companions in same city, return empty
    if (sameCityCompanions.length === 0) {
      console.log(`⚠️ No companions found in ${userCity}`);
      return res.status(200).json({
        success: true,
        count: 0,
        companions: [],
        message: `No companions available in ${userCity} yet. Check back soon!`
      });
    }

    // 7. Calculate shared hangouts and map data
    const companionsWithData = sameCityCompanions.map(companion => {
      const q = companion.questionnaire || {};
      
      // Calculate shared hangouts
      const companionHangouts = q.hangoutPreferences || [];
      const sharedHangouts = userHangouts.filter(hangout => 
        companionHangouts.includes(hangout)
      );
      const overlapCount = sharedHangouts.length;

      // ✅ LOG: Show what data exists
      console.log(`📦 ${companion.firstName}:`, {
        city: q.city,
        hangoutsCount: companionHangouts.length,
        sharedCount: sharedHangouts.length,
        hasBio: !!q.bio
      });

      return {
        id: companion._id.toString(),
        name: `${companion.firstName} ${companion.lastName}`.trim(),
        profilePhoto: companion.profilePhoto || null,
        
        // ✅ REAL USER DATA
        bio: q.bio || null,
        tagline: q.tagline || null,
        sharedHangouts: sharedHangouts.length > 0 ? sharedHangouts : [],
        overlapCount,
        vibeWords: q.vibeWords || [],
        city: q.city || null,
        state: q.state || null,
        availableTimes: q.availableTimes || [],
        languagePreference: q.languagePreference || null,
        comfortZones: q.comfortZones || [],
        becomeCompanion: q.becomeCompanion || null,
        price: q.price || null,
        photoVerificationStatus: companion.photoVerificationStatus || 'not_submitted'
      };
    });

    // 8. Sort by shared interests (highest overlap first)
    companionsWithData.sort((a, b) => b.overlapCount - a.overlapCount);

    // 9. Take top 10
    const topCompanions = companionsWithData.slice(0, 10);

    console.log(`✅ Returning ${topCompanions.length} companions`);
    console.log('👤 Top companions:', topCompanions.map(c => ({ 
      name: c.name,
      city: c.city,
      shared: c.overlapCount
    })));

    // 10. Return response
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
