const User = require('../models/User');

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

    // 3. Build query - ✅ FIXED: Simpler admin filtering
    const query = {
      _id: { $ne: currentUserId },
      // ✅ CRITICAL FIX: Only allow USER role explicitly
      role: 'USER',
      verified: true
    };

    console.log('🔎 Query:', JSON.stringify(query, null, 2));

    // 4. Fetch companions
    const eligibleCompanions = await User.find(query)
      .select(`
        _id
        firstName
        lastName
        profilePhoto
        verified
        photoVerificationStatus
        questionnaire
        lastActive
      `)
      .limit(50);

    console.log(`📊 Found ${eligibleCompanions.length} eligible companions`);

    // 5. Calculate shared hangouts
    const companionsWithOverlap = eligibleCompanions.map(companion => {
      const companionHangouts = companion.questionnaire?.hangoutPreferences || [];
      const sharedHangouts = userHangouts.filter(hangout => 
        companionHangouts.includes(hangout)
      );
      const overlapCount = sharedHangouts.length;

      return {
        id: companion._id.toString(),
        name: `${companion.firstName} ${companion.lastName}`.trim(),
        profilePhoto: companion.profilePhoto || null,
        sharedHangouts,
        overlapCount,
        bio: companion.questionnaire?.bio || null,
        tagline: companion.questionnaire?.tagline || null,
        vibeWords: companion.questionnaire?.vibeWords || [],
        city: companion.questionnaire?.city || null,
        state: companion.questionnaire?.state || null,
        availableTimes: companion.questionnaire?.availableTimes || [],
        languagePreference: companion.questionnaire?.languagePreference || null,
        comfortZones: companion.questionnaire?.comfortZones || [],
        becomeCompanion: companion.questionnaire?.becomeCompanion || null,
        price: companion.questionnaire?.price || null,
        photoVerificationStatus: companion.photoVerificationStatus
      };
    });

    // 6. Sort by overlap
    companionsWithOverlap.sort((a, b) => b.overlapCount - a.overlapCount);

    // 7. Top 5
    const topCompanions = companionsWithOverlap.slice(0, 5);

    console.log(`✅ Returning ${topCompanions.length} companions`);
    console.log('👤 Companions:', topCompanions.map(c => ({ name: c.name, overlap: c.overlapCount })));

    // 8. ✅ CRITICAL FIX: Return as 'companions' not 'data'
    res.status(200).json({
      success: true,
      count: topCompanions.length,
      companions: topCompanions  // ✅ Changed from 'data' to 'companions'
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
