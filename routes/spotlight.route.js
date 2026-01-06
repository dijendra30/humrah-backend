// routes/spotlight.route.js
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const spotlightController = require('../controllers/spotlight.controller');
const User = require('../models/User');

// GET /api/spotlight - Get spotlight companions
router.get('/', auth, async (req, res) => {
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
      role: { $nin: ['admin', 'superadmin', 'moderator'] }, // ✅ EXCLUDE ALL ADMIN TYPES
      isActive: true // Only active users
    };

    // Match city if available
    if (currentUser.city) {
      query.city = currentUser.city;
    }

    // Match interests/hangouts if available
    if (currentUser.preferences && currentUser.preferences.hangouts && currentUser.preferences.hangouts.length > 0) {
      query['preferences.hangouts'] = {
        $in: currentUser.preferences.hangouts
      };
    }

    // Find matching users
    const companions = await User.find(query)
      .select('firstName lastName profilePhoto bio preferences.hangouts')
      .limit(10) // Limit to 10 companions
      .sort({ lastActive: -1 }); // Most recently active first

    // Transform to spotlight format
    const spotlightCompanions = companions.map(user => {
      // Find shared hangouts
      const sharedHangouts = user.preferences?.hangouts?.filter(
        hangout => currentUser.preferences?.hangouts?.includes(hangout)
      ) || [];

      return {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        profilePhoto: user.profilePhoto,
        bio: user.bio,
        sharedHangouts: sharedHangouts.length > 0 ? sharedHangouts : ['New User']
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

// POST /api/spotlight/refresh - Refresh spotlight companions
router.post('/refresh', auth, async (req, res) => {
  try {
    const currentUserId = req.userId;
    
    const currentUser = await User.findById(currentUserId);
    
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Same query as GET, but shuffle results for variety
    const query = {
      _id: { $ne: currentUserId },
      role: { $nin: ['admin', 'superadmin', 'moderator'] },
      isActive: true
    };

    if (currentUser.city) {
      query.city = currentUser.city;
    }

    // Use $sample for random selection
    const companions = await User.aggregate([
      { $match: query },
      { $sample: { size: 10 } },
      { $project: {
        firstName: 1,
        lastName: 1,
        profilePhoto: 1,
        bio: 1,
        'preferences.hangouts': 1
      }}
    ]);

    const spotlightCompanions = companions.map(user => {
      const sharedHangouts = user.preferences?.hangouts?.filter(
        hangout => currentUser.preferences?.hangouts?.includes(hangout)
      ) || [];

      return {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        profilePhoto: user.profilePhoto,
        bio: user.bio,
        sharedHangouts: sharedHangouts.length > 0 ? sharedHangouts : ['New User']
      };
    });

    res.json({
      success: true,
      companions: spotlightCompanions
    });
  } catch (error) {
    console.error('Spotlight refresh error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to refresh spotlight companions'
    });
  }
});

module.exports = router;
