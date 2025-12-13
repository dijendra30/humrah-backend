// routes/users.js - User Profile Routes
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');

// @route   PUT /api/users/me
// @desc    Update user profile
// @access  Private
router.put('/me', auth, async (req, res) => {
  try {
    const updates = req.body;
    const allowedUpdates = ['firstName', 'lastName', 'profilePhoto', 'questionnaire'];
    const updateKeys = Object.keys(updates);
    
    // Filter only allowed updates
    const filteredUpdates = {};
    updateKeys.forEach(key => {
      if (allowedUpdates.includes(key)) {
        filteredUpdates[key] = updates[key];
      }
    });

    const user = await User.findByIdAndUpdate(
      req.userId,
      filteredUpdates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// ✅ NEW: Update only questionnaire
router.put('/me/questionnaire', auth, async (req, res) => {
  try {
    const { questionnaire } = req.body;

    if (!questionnaire) {
      return res.status(400).json({ 
        success: false, 
        message: 'Questionnaire data is required' 
      });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { questionnaire },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      message: 'Questionnaire saved successfully',
      user
    });

  } catch (error) {
    console.error('Save questionnaire error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      user
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   POST /api/users/upload-photo
// @desc    Upload profile photo (base64)
// @access  Private
router.post('/upload-photo', auth, async (req, res) => {
  try {
    const { photoBase64 } = req.body;

    if (!photoBase64) {
      return res.status(400).json({ 
        success: false, 
        message: 'Photo data is required' 
      });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { profilePhoto: photoBase64 },
      { new: true }
    ).select('-password');

    res.json({
      success: true,
      message: 'Photo uploaded successfully',
      profilePhoto: user.profilePhoto
    });

  } catch (error) {
    console.error('Upload photo error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

module.exports = router;