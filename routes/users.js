// routes/users.js - Fixed User Profile Routes with Buffer-Based Upload
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const { upload, uploadBuffer, uploadBase64, deleteImage } = require('../config/cloudinary');
const { sendProfileVerificationEmail } = require('../config/email');

// @route   PUT /api/users/me
// @desc    Update user profile
// @access  Private
router.put('/me', auth, async (req, res) => {
  try {
    const updates = req.body;
    const allowedUpdates = ['firstName', 'lastName', 'profilePhoto', 'questionnaire'];
    const updateKeys = Object.keys(updates);
    
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

// @route   POST /api/users/upload-profile-photo
// @desc    Upload profile photo from gallery/camera (multipart/form-data)
// @access  Private
router.post('/upload-profile-photo', auth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No photo uploaded'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete old profile photo if exists
    if (user.profilePhotoPublicId) {
      await deleteImage(user.profilePhotoPublicId);
    }

    // Upload buffer to Cloudinary
    const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/profiles');

    // Update user with new photo
    user.profilePhoto = uploadResult.url;
    user.profilePhotoPublicId = uploadResult.publicId;
    await user.save();

    res.json({
      success: true,
      message: 'Profile photo uploaded successfully',
      profilePhoto: user.profilePhoto
    });

  } catch (error) {
    console.error('Upload profile photo error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error uploading photo'
    });
  }
});

// @route   POST /api/users/upload-profile-photo-base64
// @desc    Upload profile photo as base64 (from camera or gallery)
// @access  Private
router.post('/upload-profile-photo-base64', auth, async (req, res) => {
  try {
    const { photoBase64 } = req.body;

    if (!photoBase64) {
      return res.status(400).json({
        success: false,
        message: 'No photo data provided'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete old profile photo if exists
    if (user.profilePhotoPublicId) {
      await deleteImage(user.profilePhotoPublicId);
    }

    // Upload to Cloudinary
    const uploadResult = await uploadBase64(photoBase64, 'humrah/profiles');

    // Update user
    user.profilePhoto = uploadResult.url;
    user.profilePhotoPublicId = uploadResult.publicId;
    await user.save();

    res.json({
      success: true,
      message: 'Profile photo uploaded successfully',
      profilePhoto: user.profilePhoto
    });

  } catch (error) {
    console.error('Upload profile photo error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error uploading photo'
    });
  }
});

// @route   POST /api/users/submit-verification-photo
// @desc    Submit photo for manual verification
// @access  Private
router.post('/submit-verification-photo', auth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No photo uploaded'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete old verification photo if exists
    if (user.verificationPhotoPublicId) {
      await deleteImage(user.verificationPhotoPublicId);
    }

    // Upload buffer to Cloudinary
    const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/verification');

    // Update user with verification photo
    user.verificationPhoto = uploadResult.url;
    user.verificationPhotoPublicId = uploadResult.publicId;
    user.verificationPhotoSubmittedAt = new Date();
    user.photoVerificationStatus = 'pending';
    await user.save();

    res.json({
      success: true,
      message: 'Verification photo submitted successfully. Our team will review it soon.',
      verificationPhoto: user.verificationPhoto,
      photoVerificationStatus: user.photoVerificationStatus
    });

  } catch (error) {
    console.error('Submit verification photo error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/users/submit-verification-photo-base64
// @desc    Submit verification photo as base64
// @access  Private
router.post('/submit-verification-photo-base64', auth, async (req, res) => {
  try {
    const { photoBase64 } = req.body;

    if (!photoBase64) {
      return res.status(400).json({
        success: false,
        message: 'No photo data provided'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete old verification photo if exists
    if (user.verificationPhotoPublicId) {
      await deleteImage(user.verificationPhotoPublicId);
    }

    // Upload to Cloudinary
    const uploadResult = await uploadBase64(photoBase64, 'humrah/verification');

    // Update user
    user.verificationPhoto = uploadResult.url;
    user.verificationPhotoPublicId = uploadResult.publicId;
    user.verificationPhotoSubmittedAt = new Date();
    user.photoVerificationStatus = 'pending';
    await user.save();

    res.json({
      success: true,
      message: 'Verification photo submitted successfully. Our team will review it soon.',
      verificationPhoto: user.verificationPhoto,
      photoVerificationStatus: user.photoVerificationStatus
    });

  } catch (error) {
    console.error('Submit verification photo error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/users/me/questionnaire
// @desc    Merge & update questionnaire safely (multi-step onboarding)
// @access  Private
router.put('/me/questionnaire', auth, async (req, res) => {
  try {
    const { questionnaire } = req.body;

    if (!questionnaire || typeof questionnaire !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Questionnaire data is required'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // ✅ Merge questionnaire instead of overwriting
    user.questionnaire = {
      ...(user.questionnaire?.toObject?.() || user.questionnaire || {}),
      ...questionnaire
    };

    await user.save();

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

// ==================== ADMIN ROUTES ====================

// @route   PUT /api/users/:userId/verify-photo
// @desc    Admin: Approve or reject user's verification photo
// @access  Private (Admin only - implement admin middleware)
router.put('/:userId/verify-photo', auth, async (req, res) => {
  try {
    // TODO: Add admin middleware to check if user is admin
    const { userId } = req.params;
    const { approved } = req.body; // true or false

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.verificationPhoto) {
      return res.status(400).json({
        success: false,
        message: 'No verification photo to review'
      });
    }

    // Update verification status
    user.photoVerificationStatus = approved ? 'approved' : 'rejected';
    user.photoVerifiedAt = new Date();
    user.photoVerifiedBy = req.userId; // Admin ID
    user.verified = user.isFullyVerified(); // Update overall verified status
    await user.save();

    // Send notification email
    try {
      await sendProfileVerificationEmail(user.email, user.firstName, approved);
    } catch (emailError) {
      console.error('Error sending verification email:', emailError);
    }

    res.json({
      success: true,
      message: `Photo verification ${approved ? 'approved' : 'rejected'} successfully`,
      user: {
        id: user._id,
        photoVerificationStatus: user.photoVerificationStatus,
        verified: user.verified,
        photoVerifiedAt: user.photoVerifiedAt
      }
    });

  } catch (error) {
    console.error('Verify photo error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/users/admin/pending-verifications
// @desc    Admin: Get all users pending photo verification
// @access  Private (Admin only)
router.get('/admin/pending-verifications', auth, async (req, res) => {
  try {
    // TODO: Add admin middleware

    const users = await User.find({
      photoVerificationStatus: 'pending',
      verificationPhoto: { $ne: null }
    })
    .select('firstName lastName email verificationPhoto verificationPhotoSubmittedAt')
    .sort({ verificationPhotoSubmittedAt: -1 });

    res.json({
      success: true,
      count: users.length,
      users
    });

  } catch (error) {
    console.error('Get pending verifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;


