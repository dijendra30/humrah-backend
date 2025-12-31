// controllers/spotlight.controller.js
const User = require('../models/User');

/**
 * @route   GET /api/spotlight
 * @desc    Get personalized companion recommendations based on shared hangout preferences
 * @access  Private (requires authentication)
 */
exports.getSpotlightCompanions = async (req, res) => {
  try {
    const currentUserId = req.userId; // ✅ Your auth middleware uses req.userId

    // 1. Fetch current user with their hangout preferences
    const currentUser = await User.findById(currentUserId).select('questionnaire');
    
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // ✅ Get hangout preferences from questionnaire
    const userHangouts = currentUser.questionnaire?.hangoutPreferences || [];

    // 2. Define eligibility criteria
    const now = new Date();
    const seventyTwoHoursAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);

    // 3. Fetch eligible companions
    const eligibleCompanions = await User.find({
      _id: { $ne: currentUserId },
      verified: true, // ✅ Only verified users
      // Remove these filters for now if they don't exist in your User model
      // profileCompletion: { $gte: 80 },
      // lastActiveAt: { $gte: seventyTwoHoursAgo }
    })
    .select(`
  _id
  firstName
  lastName
  profilePhoto
  verified
  questionnaire
  lastActive
`)

    .limit(50); // Get more to filter from

    console.log(`Found ${eligibleCompanions.length} eligible companions`);

    // 4. Calculate shared hangouts and overlap count
    const companionsWithOverlap = eligibleCompanions.map(companion => {
      const companionHangouts = companion.questionnaire?.hangoutPreferences || [];
      
      // Calculate intersection
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
photoVerificationStatus: companion.photoVerificationStatus || "not_submitted"

};
 
    });

    // 5. Sort companions by overlap count (DESC), then by last active
    companionsWithOverlap.sort((a, b) => {
      if (b.overlapCount !== a.overlapCount) {
        return b.overlapCount - a.overlapCount;
      }
      return new Date(b.lastActiveAt) - new Date(a.lastActiveAt);
    });

    // 6. Limit to top 5
    const topCompanions = companionsWithOverlap.slice(0, 5);

    // 7. Clean up response
    const cleanedCompanions = topCompanions.map(({ lastActiveAt, ...companion }) => companion);

    console.log(`Returning ${cleanedCompanions.length} spotlight companions`);

    // 8. Return response
    res.status(200).json({
      success: true,
      count: cleanedCompanions.length,
      data: cleanedCompanions
    });

  } catch (error) {
    console.error('Error fetching spotlight companions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch spotlight companions',
      error: error.message
    });
  }
};
