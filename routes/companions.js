// routes/companions.js - UPDATED Companion Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');

// @route   GET /api/companions
// @desc    Get list of companions (only users with userType='COMPANION')
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const { interests, city, state, limit = 20 } = req.query;
    
    // ✅ CRITICAL FIX: Only show COMPANION users
    const filter = { 
      _id: { $ne: req.userId },
      userType: 'COMPANION',      // ✅ Only companions
      status: 'ACTIVE'             // Only active users
    };

    if (interests) {
      const interestArray = interests.split(',');
      filter['questionnaire.interests'] = { $in: interestArray };
    }

    if (city) filter['questionnaire.city'] = city;
    if (state) filter['questionnaire.state'] = state;

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(parseInt(limit))
      .sort({ 
        isPremium: -1,                    // Premium first
        'ratingStats.averageRating': -1,  // Then by rating
        lastActive: -1                     // Then by activity
      });

    res.json({
      success: true,
      companions
    });

  } catch (error) {
    console.error('Get companions error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/companions/recommended
// @desc    Get recommended companions (only userType='COMPANION')
// @access  Private
router.get('/recommended', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId);
    
    if (!currentUser || !currentUser.questionnaire) {
      return res.status(400).json({ 
        success: false, 
        message: 'Complete your profile first' 
      });
    }

    // ✅ CRITICAL FIX: Only show COMPANION users
    const filter = { 
      _id: { $ne: req.userId },
      userType: 'COMPANION',  // ✅ Only companions
      status: 'ACTIVE'
    };

    // Match by location
    if (currentUser.questionnaire.city) {
      filter['questionnaire.city'] = currentUser.questionnaire.city;
    }

    // Match by interests
    if (currentUser.questionnaire.interests?.length > 0) {
      filter['questionnaire.interests'] = { 
        $in: currentUser.questionnaire.interests 
      };
    }

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(10)
      .sort({ 
        'ratingStats.averageRating': -1,
        lastActive: -1 
      });

    res.json({
      success: true,
      companions
    });

  } catch (error) {
    console.error('Get recommended companions error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/companions/:companionId
// @desc    Get companion profile details
// @access  Private
router.get('/:companionId', auth, async (req, res) => {
  try {
    const companion = await User.findOne({
      _id: req.params.companionId,
      userType: 'COMPANION',  // ✅ Must be companion
      status: 'ACTIVE'
    }).select('-password -emailVerificationOTP -fcmTokens');

    if (!companion) {
      return res.status(404).json({
        success: false,
        message: 'Companion not found'
      });
    }

    res.json({
      success: true,
      companion: companion.getPublicProfile()
    });

  } catch (error) {
    console.error('Get companion error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
