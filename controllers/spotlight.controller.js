// controllers/spotlight.controller.js - FINAL WORKING VERSION
const User = require('../models/User');

/**
 * @route   GET /api/spotlight
 * @desc    Get companions with real user data
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

    // 3. ✅ SIMPLE QUERY: Just exclude self and admins
    const query = {
      _id: { $ne: currentUserId },
      role: 'USER' // ✅ ONLY USER role
    };

    console.log('🔎 Query:', JSON.stringify(query, null, 2));

    // 4. Fetch ALL user companions (we'll sort by city later)
    const eligibleCompanions = await User.find(query)
      .select('_id firstName lastName profilePhoto verified photoVerificationStatus questionnaire')
      .limit(100); // Get more to filter from

    console.log(`📊 Found ${eligibleCompanions.length} eligible companions`);

    if (eligibleCompanions.length === 0) {
      console.log('⚠️ No companions found in database');
      return res.status(200).json({
        success: true,
        count: 0,
        companions: []
      });
    }

    // 5. Calculate shared hangouts and prioritize by city match
    const companionsWithData = eligibleCompanions.map(companion => {
      const q = companion.questionnaire || {};
      
      // Calculate shared hangouts
      const companionHangouts = q.hangoutPreferences || [];
      const sharedHangouts = userHangouts.filter(hangout => 
        companionHangouts.includes(hangout)
      );
      const overlapCount = sharedHangouts.length;

      // Check if same city
      const isSameCity = userCity && q.city && 
        q.city.toLowerCase() === userCity.toLowerCase();

      // ✅ LOG: Show what data exists
      console.log(`📦 ${companion.firstName}:`, {
        city: q.city || 'not set',
        sameCity: isSameCity,
        hangoutsCount: companionHangouts.length,
        sharedCount: sharedHangouts.length,
        hasBio: !!q.bio
      });

      return {
        id: companion._id.toString(),
        name: `${companion.firstName} ${companion.lastName}`.trim(),
        profilePhoto: companion.profilePhoto || null,
        
        // ✅ REAL USER DATA (null if empty)
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
        photoVerificationStatus: companion.photoVerificationStatus || 'not_submitted',
        
        // Internal: for sorting
        _isSameCity: isSameCity,
        _sortScore: (isSameCity ? 1000 : 0) + overlapCount
      };
    });

    // 6. ✅ SORT: Same city first, then by shared interests
    companionsWithData.sort((a, b) => b._sortScore - a._sortScore);

    // 7. Clean up internal fields and take top 10
    const topCompanions = companionsWithData
      .slice(0, 10)
      .map(({ _isSameCity, _sortScore, ...companion }) => companion);

    console.log(`✅ Returning ${topCompanions.length} companions`);
    console.log('👤 Top companions:', topCompanions.map(c => ({ 
      name: c.name,
      city: c.city,
      shared: c.overlapCount
    })));

    // 8. Return response
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
