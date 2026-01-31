// routes/profile.js - Profile Viewing and Editing Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const ProfileEditLog = require('../models/ProfileEditLog');
const Review = require('../models/Review');

// @route   GET /api/profile/:userId
// @desc    Get public profile view for any user
// @access  Private (authenticated users only)
router.get('/:userId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if account is deleted
    if (user.deletedAt) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Get public profile data
    const publicProfile = user.getPublicProfile();
    
    res.json({
      success: true,
      profile: publicProfile
    });
    
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/profile/me/private
// @desc    Get full profile for logged-in user (including private data)
// @access  Private
router.get('/me/private', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Get private profile data
    const privateProfile = user.getPrivateProfile();
    
    // Get editable fields info
    const editableFields = {};
    const fields = ['profilePhoto', 'bio', 'ageGroup', 'state', 'area', 'price', 'tagline'];
    
    for (const field of fields) {
      const rateLimit = await ProfileEditLog.checkRateLimit(req.userId, field);
      editableFields[field] = rateLimit;
    }
    
    res.json({
      success: true,
      profile: privateProfile,
      editableFields
    });
    
  } catch (error) {
    console.error('Get private profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/profile/me
// @desc    Update profile fields
// @access  Private
router.put('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const updates = req.body.questionnaire || {};
    const updatedFields = [];
    const rateLimitErrors = [];
    
    // Process each field update
    for (const [field, newValue] of Object.entries(updates)) {
      // Skip if value hasn't changed
      const oldValue = user.questionnaire?.[field];
      if (oldValue === newValue) continue;
      
      // Check rate limit
      const rateLimit = await ProfileEditLog.checkRateLimit(req.userId, field);
      if (!rateLimit.allowed) {
        rateLimitErrors.push({
          field,
          message: rateLimit.reason,
          resetAt: rateLimit.resetAt
        });
        continue;
      }
      
      // Validate specific fields
      if (field === 'bio' && newValue && newValue.length > 150) {
        return res.status(400).json({
          success: false,
          message: 'Bio must be 150 characters or less'
        });
      }
      
      if (field === 'tagline' && newValue && newValue.length > 30) {
        return res.status(400).json({
          success: false,
          message: 'Tagline must be 30 characters or less'
        });
      }
      
      // Profanity filter
      if ((field === 'bio' || field === 'tagline') && newValue) {
        const hasProfanity = checkProfanity(newValue);
        if (hasProfanity) {
          return res.status(400).json({
            success: false,
            message: 'Content contains inappropriate language'
          });
        }
      }
      
      // URL detection for bio
      if (field === 'bio' && newValue) {
        const hasUrl = /https?:\/\/|www\./i.test(newValue);
        if (hasUrl) {
          return res.status(400).json({
            success: false,
            message: 'Bio cannot contain URLs'
          });
        }
      }
      
      // Update field
      if (!user.questionnaire) {
        user.questionnaire = {};
      }
      user.questionnaire[field] = newValue;
      
      // Log edit
      await ProfileEditLog.logEdit(req.userId, field, oldValue, newValue, {
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      
      // Update stats
      if (field === 'bio') {
        user.profileEditStats.lastBioUpdate = new Date();
      } else if (field === 'ageGroup') {
        user.profileEditStats.lastAgeGroupUpdate = new Date();
      }
      user.profileEditStats.totalEdits += 1;
      
      updatedFields.push(field);
    }
    
    // Save user
    if (updatedFields.length > 0) {
      await user.save();
    }
    
    // Return response
    if (rateLimitErrors.length > 0) {
      return res.status(429).json({
        success: false,
        message: 'Some fields could not be updated due to rate limits',
        updatedFields,
        rateLimitErrors
      });
    }
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      updatedFields
    });
    
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/profile/me/edit-history
// @desc    Get user's own edit history
// @access  Private
router.get('/me/edit-history', auth, async (req, res) => {
  try {
    const { days = 30, page = 1, limit = 20 } = req.query;
    
    const history = await ProfileEditLog.getUserEditHistory(req.userId, {
      days: parseInt(days),
      page: parseInt(page),
      limit: parseInt(limit)
    });
    
    res.json({
      success: true,
      history
    });
    
  } catch (error) {
    console.error('Get edit history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/profile/me/delete
// @desc    Delete user account (soft delete)
// @access  Private
router.post('/me/delete', auth, async (req, res) => {
  try {
    const { reason, confirmPendingPayoutForfeit } = req.body;
    
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check for pending payout
    if (user.paymentInfo && user.paymentInfo.pendingPayout > 0) {
      if (!confirmPendingPayoutForfeit) {
        return res.status(400).json({
          success: false,
          message: 'You have pending payouts. Please confirm forfeit or withdraw first.',
          pendingAmount: user.paymentInfo.pendingPayout
        });
      }
    }
    
    // Soft delete
    await user.softDelete(reason || 'User requested deletion');
    
    res.json({
      success: true,
      message: 'Account deleted successfully'
    });
    
  } catch (error) {
    if (error.message.includes('active bookings') || error.message.includes('pending payouts')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Simple profanity filter
 */
function checkProfanity(text) {
  const profanityList = [
    // Add your profanity list here
    'badword1', 'badword2'
  ];
  
  const lowerText = text.toLowerCase();
  return profanityList.some(word => lowerText.includes(word));
}

module.exports = router;
