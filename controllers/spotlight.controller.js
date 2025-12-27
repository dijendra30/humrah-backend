// controllers/spotlight.controller.js
const User = require('../models/User');

/**
 * @route   GET /api/spotlight
 * @desc    Get personalized companion recommendations based on shared hangout preferences
 * @access  Private (requires authentication)
 * 
 * Algorithm:
 * 1. Fetch current user's hangout preferences
 * 2. Find eligible companions (active, verified, profile complete)
 * 3. Calculate overlap between user's and companion's hangout preferences
 * 4. Sort by overlap count, response rate, and last active time
 * 5. Return top 5 companions with their shared hangouts
 */
exports.getSpotlightCompanions = async (req, res) => {
  try {
    const currentUserId = req.user.id; // Set by protect middleware

    // 1. Fetch current user with their hangout preferences
    const currentUser = await User.findById(currentUserId).select('hangoutPreferences');
    
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userHangouts = currentUser.hangoutPreferences || [];

    // 2. Define eligibility criteria
    const now = new Date();
    const seventyTwoHoursAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);

    // 3. Fetch eligible companions
    // Exclude: self, users with low profile completion, inactive users
    const eligibleCompanions = await User.find({
      _id: { $ne: currentUserId }, // Not the current user
      profileCompletion: { $gte: 80 }, // At least 80% profile complete
      lastActiveAt: { $gte: seventyTwoHoursAgo }, // Active in last 72 hours
      // Optional: Add additional filters
      // emailVerified: true,
      // photoVerified: true
    }).select('_id firstName lastName profilePhoto hangoutPreferences responseRate lastActiveAt');

    // 4. Calculate shared hangouts and overlap count for each companion
    const companionsWithOverlap = eligibleCompanions.map(companion => {
      const companionHangouts = companion.hangoutPreferences || [];
      
      // Calculate intersection of hangout preferences
      const sharedHangouts = userHangouts.filter(hangout => 
        companionHangouts.includes(hangout)
      );
      
      const overlapCount = sharedHangouts.length;

      return {
        id: companion._id.toString(),
        name: `${companion.firstName} ${companion.lastName}`.trim(),
        profilePhoto: companion.profilePhoto || null,
        sharedHangouts: sharedHangouts, // Only shared preferences
        overlapCount: overlapCount,
        responseRate: companion.responseRate || 0,
        lastActiveAt: companion.lastActiveAt || companion.createdAt
      };
    });

    // 5. Sort companions by priority
    // Primary: overlapCount (DESC) - users with most shared interests first
    // Secondary: responseRate (DESC) - reliable companions
    // Tertiary: lastActiveAt (DESC) - recently active users
    companionsWithOverlap.sort((a, b) => {
      // Sort by overlap count first
      if (b.overlapCount !== a.overlapCount) {
        return b.overlapCount - a.overlapCount;
      }
      
      // If overlap is same, sort by response rate
      if (b.responseRate !== a.responseRate) {
        return b.responseRate - a.responseRate;
      }
      
      // If response rate is same, sort by last active
      return new Date(b.lastActiveAt) - new Date(a.lastActiveAt);
    });

    // 6. Limit to top 5 companions
    const topCompanions = companionsWithOverlap.slice(0, 5);

    // 7. Remove internal fields before sending response
    const cleanedCompanions = topCompanions.map(({ responseRate, lastActiveAt, ...companion }) => companion);

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
