// routes/companions.js - Companion Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');

// @route   GET /api/companions
// @desc    Get list of companions/users
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const { interests, city, state, limit = 20 } = req.query;
    
    const filter = { _id: { $ne: req.userId } };

    if (interests) {
      const interestArray = interests.split(',');
      filter['questionnaire.interests'] = { $in: interestArray };
    }

    if (city) filter['questionnaire.city'] = city;
    if (state) filter['questionnaire.state'] = state;

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire.interests questionnaire.city verified isPremium')
      .limit(parseInt(limit))
      .sort({ lastActive: -1 });

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
// @desc    Get recommended companions
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

    const filter = { _id: { $ne: req.userId } };

    if (currentUser.questionnaire.city) {
      filter['questionnaire.city'] = currentUser.questionnaire.city;
    }

    if (currentUser.questionnaire.interests?.length > 0) {
      filter['questionnaire.interests'] = { 
        $in: currentUser.questionnaire.interests 
      };
    }

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire.interests questionnaire.city verified isPremium')
      .limit(10)
      .sort({ lastActive: -1 });

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


module.exports = router;
