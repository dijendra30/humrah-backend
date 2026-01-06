// routes/spotlight.route.js
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const spotlightController = require('../controllers/spotlight.controller');

// ✅ Debug: Check if controller loaded correctly
console.log('Spotlight controller loaded:', {
  controllerExists: !!spotlightController,
  getSpotlightCompanions: typeof spotlightController.getSpotlightCompanions
});

// GET /api/spotlight - Get spotlight companions
router.get('/spotlight', auth, async (req, res) => {
  try {
    const currentUserId = req.userId;
    
    // Get current user to match preferences
    const currentUser = await User.findById(currentUserId);
    
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Build query to find matching companions
    const query = {
      _id: { $ne: currentUserId }, // Exclude self
      role: { $ne: 'admin' }, // ✅ EXCLUDE ADMINS
      isActive: true, // Only active users
      // Add other filters based on preferences
    };

    // If user has preferences, match them
    if (currentUser.preferences) {
      // Match city
      if (currentUser.city) {
        query.city = currentUser.city;
      }

      // Match interests/hangouts
      if (currentUser.preferences.interests && currentUser.preferences.interests.length > 0) {
        query['preferences.interests'] = {
          $in: currentUser.preferences.interests
        };
      }
    }

    // Find matching users
    const companions = await User.find(query)
      .select('firstName lastName profilePhoto bio preferences.interests preferences.hangouts')
      .limit(10) // Limit to 10 companions
      .sort({ lastActive: -1 }); // Most recently active first

    // Transform to spotlight format
    const spotlightCompanions = companions.map(user => {
      // Find shared interests/hangouts
      const sharedHangouts = user.preferences?.hangouts?.filter(
        hangout => currentUser.preferences?.hangouts?.includes(hangout)
      ) || [];

      return {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        profilePhoto: user.profilePhoto,
        bio: user.bio,
        sharedHangouts
      };
    });

    res.json({
      success: true,
      companions: spotlightCompanions
    });
  } catch (error) {
    console.error('Spotlight error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch spotlight companions'
    });
  }
});
module.exports = router;
