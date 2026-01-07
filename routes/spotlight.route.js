// routes/spotlight.route.js - FIXED VERSION
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const spotlightController = require('../controllers/spotlight.controller');
const User = require('../models/User');

// GET /api/spotlight - Get spotlight companions
router.get('/', auth, async (req, res) => {
  try {
    const currentUserId = req.userId;
    
    console.log('Spotlight request from user:', currentUserId);
    
    // Get current user
    const currentUser = await User.findById(currentUserId);
    
    if (!currentUser) {
      console.log('âŒ Current user not found');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log('âœ… Current user:', {
      id: currentUser._id,
      name: `${currentUser.firstName} ${currentUser.lastName}`,
      city: currentUser.city,
      role: currentUser.role
    });

    // ==================== STRATEGY 1: Try strict matching ====================
    let companions = [];
    
    // Build query - Start with ONLY essential filters
    const baseQuery = {
      _id: { $ne: currentUserId }, // Exclude self
      // âœ… FIX: Make role filter optional - check if field exists
      $or: [
        { role: { $exists: false } }, // Users without role field
        { role: 'user' }, // Explicit user role
        { role: { $nin: ['SAFETY_ADMIN', 'SUPER_ADMIN', 'moderator'] } } // Exclude admins
      ]
    };

    // Add city filter if available (optional)
    if (currentUser.city) {
      baseQuery.city = currentUser.city;
    }

    console.log('ðŸ”Ž Base query:', JSON.stringify(baseQuery, null, 2));

    // Try to find companions with base query
    companions = await User.find(baseQuery)
      .select('firstName lastName profilePhoto bio preferences role')
      .limit(10)
      .sort({ createdAt: -1 }); // Most recent users first

    console.log(`ðŸ“Š Found ${companions.length} companions with base query`);

    // ==================== STRATEGY 2: Fallback - Remove city filter ====================
    if (companions.length === 0 && currentUser.city) {
      console.log('ðŸ”„ No companions found in city, trying without city filter...');
      
      delete baseQuery.city;
      
      companions = await User.find(baseQuery)
        .select('firstName lastName profilePhoto bio preferences role')
        .limit(10)
        .sort({ createdAt: -1 });
      
      console.log(`ðŸ“Š Found ${companions.length} companions without city filter`);
    }

    // ==================== STRATEGY 3: Super fallback - Just exclude self and admins ====================
    if (companions.length === 0) {
      console.log('ðŸ”„ Still no companions, trying super fallback...');
      
      companions = await User.find({
        _id: { $ne: currentUserId },
        $or: [
          { role: { $exists: false } },
          { role: { $ne: 'admin' } }
        ]
      })
      .select('firstName lastName profilePhoto bio preferences role')
      .limit(10)
      .sort({ createdAt: -1 });
      
      console.log(`ðŸ“Š Super fallback found ${companions.length} companions`);
    }

    // ==================== Log what we found ====================
    console.log('ðŸ‘¥ Final companions:', companions.map(u => ({
      id: u._id,
      name: `${u.firstName} ${u.lastName}`,
      role: u.role,
      city: u.city
    })));

    // Transform to spotlight format
    const spotlightCompanions = companions.map(user => {
      // Safely extract shared hangouts
      let sharedHangouts = [];
      
      try {
        const userHangouts = user.preferences?.hangouts || [];
        const currentUserHangouts = currentUser.preferences?.hangouts || [];
        
        sharedHangouts = userHangouts.filter(
          hangout => currentUserHangouts.includes(hangout)
        );
      } catch (error) {
        console.log('âš ï¸ Error calculating shared hangouts:', error);
      }

     return {
  id: user._id.toString(),
  name: `${user.firstName} ${user.lastName}`,
  profilePhoto: user.profilePhoto || null,
  
  // ✅ ADD ALL MISSING FIELDS
  bio: user.questionnaire?.bio || "New user exploring Humrah! Say hi 👋",
  tagline: user.questionnaire?.tagline || "Ready to meet new people!",
  sharedHangouts: sharedHangouts.length > 0 ? sharedHangouts : ["New User"],
  overlapCount: sharedHangouts.length,
  vibeWords: user.questionnaire?.vibeWords?.length > 0 
    ? user.questionnaire.vibeWords 
    : ["Friendly", "Open-minded"],
  city: user.questionnaire?.city || "India",
  state: user.questionnaire?.state || null,
  availableTimes: user.questionnaire?.availableTimes || ["Weekends", "Evenings"],
  languagePreference: user.questionnaire?.languagePreference || "English",
  comfortZones: user.questionnaire?.comfortZones || ["Public places", "Cafes"],
  becomeCompanion: user.questionnaire?.becomeCompanion || null,
  price: user.questionnaire?.price || null,
  photoVerificationStatus: user.photoVerificationStatus || 'not_submitted'
};
    });

    console.log('Returning', spotlightCompanions.length, 'companions');

    res.json({
      success: true,
      companions: spotlightCompanions
    });
  } catch (error) {
    console.error('âŒ Spotlight error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch spotlight companions',
      error: error.message
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

    // Simple query for refresh - just exclude self and admins
    const query = {
      _id: { $ne: currentUserId },
      $or: [
        { role: { $exists: false } },
        { role: { $ne: 'admin' } }
      ]
    };

    // Use $sample for random selection
    let companions = [];
    
    try {
      companions = await User.aggregate([
        { $match: query },
        { $sample: { size: 10 } },
        { $project: {
          firstName: 1,
          lastName: 1,
          profilePhoto: 1,
          bio: 1,
          preferences: 1
        }}
      ]);
    } catch (error) {
      // Fallback if aggregate fails
      console.log('Aggregate failed, using find...');
      companions = await User.find(query)
        .select('firstName lastName profilePhoto bio preferences')
        .limit(10)
        .sort({ createdAt: -1 });
    }

    const spotlightCompanions = companions.map(user => {
      let sharedHangouts = [];
      
      try {
        const userHangouts = user.preferences?.hangouts || [];
        const currentUserHangouts = currentUser.preferences?.hangouts || [];
        
        sharedHangouts = userHangouts.filter(
          hangout => currentUserHangouts.includes(hangout)
        );
      } catch (error) {
        // Ignore
      }

      return {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        profilePhoto: user.profilePhoto || null,
        bio: user.bio || null,
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
      message: 'Failed to refresh spotlight companions',
      error: error.message
    });
  }
});

// DEBUG ENDPOINT - Remove after testing
router.get('/debug', auth, async (req, res) => {
  try {
    const currentUserId = req.userId;
    
    const totalUsers = await User.countDocuments();
    const currentUser = await User.findById(currentUserId);
    const usersInCity = await User.countDocuments({ 
      city: currentUser?.city,
      _id: { $ne: currentUserId }
    });
    const admins = await User.countDocuments({ 
      role: { $in: ['SAFETY_ADMIN', 'SUPER_ADMIN', 'moderator'] }
    });
    const regularUsers = await User.countDocuments({
      _id: { $ne: currentUserId },
      $or: [
        { role: { $exists: false } },
        { role: { $ne: 'admin' } }
      ]
    });

    const sampleUsers = await User.find({})
      .select('firstName lastName city role')
      .limit(5);

    res.json({
      debug: {
        currentUser: {
          id: currentUser?._id,
          name: `${currentUser?.firstName} ${currentUser?.lastName}`,
          city: currentUser?.city,
          role: currentUser?.role
        },
        stats: {
          totalUsers,
          usersInCity,
          admins,
          regularUsers,
          eligibleForSpotlight: regularUsers
        },
        sampleUsers: sampleUsers.map(u => ({
          name: `${u.firstName} ${u.lastName}`,
          city: u.city,
          role: u.role
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
