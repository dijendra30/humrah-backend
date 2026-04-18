// routes/users.js - Complete User Routes with FCM Support + LOCATION SUPPORT
const express = require('express');
const router = express.Router();

// ✅ Import middleware
const { authenticate, authorize, adminOnly, superAdminOnly, auditLog } = require('../middleware/auth');

const User = require('../models/User');
const { upload, uploadBuffer, uploadBase64, deleteImage } = require('../config/cloudinary');
const { moderateQuestionnaire, applyStrikesAndEnforce, buildModerationResponse, buildAutoCleanSuccessResponse, LEVEL } = require('../middleware/moderation');
const userActivityCtrl = require('../controllers/userActivityController');

// @route   GET /api/users/activity
// @desc    Get lightweight activity dashboard (booking stats + refs)
// @access  Private
router.get('/activity', authenticate, userActivityCtrl.getUserActivity);

// ==================== USER PROFILE ROUTES ====================

// @route   PUT /api/users/me
// @desc    Update user profile
// @access  Private
router.put('/me', authenticate, async (req, res) => {
  try {
    const updates = req.body;
    const allowedUpdates = ['firstName', 'lastName', 'profilePhoto', 'questionnaire'];

    const filteredUpdates = {};
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) filteredUpdates[key] = updates[key];
    });

    // ── Moderate questionnaire text fields if present ──────────
    if (filteredUpdates.questionnaire && typeof filteredUpdates.questionnaire === 'object') {
      const { cleanedQuestionnaire, violations, errors } = await moderateQuestionnaire(filteredUpdates.questionnaire);

      if (violations.length > 0) {
        const user = await User.findById(req.userId);
        if (user) await user.addModerationStrike(violations, 'PUT /api/users/me');
      }

      if (errors.length > 0) {
        return res.status(422).json({
          success: false,
          code: 'MODERATION_FAILED',
          message: "Some fields contain content that isn't allowed.",
          errors,
        });
      }

      filteredUpdates.questionnaire = cleanedQuestionnaire;
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      filteredUpdates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, message: 'Profile updated successfully', user });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private
router.get('/:id', authenticate, async (req, res) => {
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

// @route   DELETE /api/users/me
// @desc    Delete user account
// @access  Private
router.delete('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete profile photo if exists
    if (user.profilePhotoPublicId) {
      await deleteImage(user.profilePhotoPublicId);
    }

    // Delete verification photo if exists
    if (user.verificationPhotoPublicId) {
      await deleteImage(user.verificationPhotoPublicId);
    }

    await User.findByIdAndDelete(req.userId);

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ==================== LOCATION ROUTE ====================

// @route   POST /api/users/location
// @desc    Update user's last known location
// @access  Private
router.post('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng, timestamp } = req.body;

    // Validate input
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required'
      });
    }

    // Validate lat/lng ranges
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid latitude or longitude values'
      });
    }

    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // ✅ Update location (overwrites previous value - no history)
    user.updateLocation(lat, lng);
    await user.save();

    console.log(`📍 Location updated for user ${user._id}: (${lat}, ${lng})`);

    res.json({
      success: true,
      message: 'Location updated successfully',
      location: {
        last_known_lat: user.last_known_lat,
        last_known_lng: user.last_known_lng,
        last_location_updated_at: user.last_location_updated_at
      }
    });

  } catch (error) {
    console.error('❌ Location update error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating location'
    });
  }
});

// ==================== FCM TOKEN MANAGEMENT ====================

// @route   POST /api/users/fcm-token
// @desc    Register FCM token for push notifications
// @access  Private
router.post('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // ✅ Initialize fcmTokens array if it doesn't exist
    if (!user.fcmTokens) {
      user.fcmTokens = [];
    }

    // ✅ Check if token already exists
    const tokenExists = user.fcmTokens.includes(fcmToken);

    if (!tokenExists) {
      // Add token (keep max 5 tokens per user - for multiple devices)
      user.fcmTokens.push(fcmToken);

      // Keep only last 5 tokens
      if (user.fcmTokens.length > 5) {
        user.fcmTokens = user.fcmTokens.slice(-5);
      }

      await user.save();
      console.log(`✅ FCM token registered for user ${user._id}`);
    } else {
      console.log(`ℹ️ FCM token already registered for user ${user._id}`);
    }

    res.json({
      success: true,
      message: 'FCM token registered successfully'
    });

  } catch (error) {
    console.error('❌ FCM token registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to register FCM token'
    });
  }
});

// @route   DELETE /api/users/fcm-token
// @desc    Remove FCM token (for logout)
// @access  Private
router.delete('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required'
      });
    }

    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.fcmTokens) {
      user.fcmTokens = user.fcmTokens.filter(token => token !== fcmToken);
      await user.save();
      console.log(`✅ FCM token removed for user ${user._id}`);
    }

    res.json({
      success: true,
      message: 'FCM token removed successfully'
    });

  } catch (error) {
    console.error('❌ FCM token removal error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove FCM token'
    });
  }
});

// ==================== PHOTO UPLOAD ROUTES ====================

// @route   POST /api/users/upload-profile-photo
// @desc    Upload profile photo from gallery/camera (multipart/form-data)
// @access  Private
router.post('/upload-profile-photo', authenticate, upload.single('photo'), async (req, res) => {
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
router.post('/upload-profile-photo-base64', authenticate, async (req, res) => {
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
router.post('/submit-verification-photo', authenticate, upload.single('photo'), async (req, res) => {
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
router.post('/submit-verification-photo-base64', authenticate, async (req, res) => {
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

// ==================== QUESTIONNAIRE ROUTES ====================

// @route   PUT /api/users/me/questionnaire
// @desc    Merge & update questionnaire safely (multi-step onboarding)
// @access  Private
router.put('/me/questionnaire', authenticate, async (req, res) => {
  try {
    const { questionnaire } = req.body;

    if (!questionnaire || typeof questionnaire !== 'object') {
      return res.status(400).json({ success: false, message: 'Questionnaire data is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // ── Full moderation pipeline ───────────────────────────────
    const { cleanedQuestionnaire, violations, errors, autoCleanedFields } = await moderateQuestionnaire(questionnaire);

    // Apply strikes and enforce consequences (suspension, ban, etc.)
    let enforcement = { enforced: false, action: null, message: null, suspendUntil: null };
    if (violations.length > 0) {
      enforcement = await applyStrikesAndEnforce(user, violations, 'PUT /api/users/me/questionnaire');
    }

    // Reject if any field had SOFT/MODERATE/SEVERE violations
    if (errors.length > 0) {
      return res.status(422).json(
        buildModerationResponse(errors, enforcement, autoCleanedFields)
      );
    }

    // ── Merge cleaned questionnaire ────────────────────────────
    user.questionnaire = {
      ...(user.questionnaire?.toObject?.() || user.questionnaire || {}),
      ...cleanedQuestionnaire,
    };

    user.markModified('questionnaire');
    await user.save();

    const successResponse = buildAutoCleanSuccessResponse(autoCleanedFields || []);
    res.json({ ...successResponse, message: 'Questionnaire saved successfully', user });

  } catch (error) {
    console.error('Save questionnaire error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== ADMIN ROUTES ====================

// @route   PUT /api/users/:userId/verify-photo
// @desc    Admin: Approve or reject user's verification photo
// @access  Private (Admin only)
router.put(
  '/:userId/verify-photo',
  authenticate,
  adminOnly,
  auditLog('VERIFY_USER_PHOTO', 'USER'),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { approved } = req.body;

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
      user.photoVerifiedBy = req.userId;
      user.verified = user.isFullyVerified();
      await user.save();

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
  }
);

// @route   GET /api/users/admin/pending-verifications
// @desc    Admin: Get all users pending photo verification
// @access  Private (Admin only)
router.get('/admin/pending-verifications', authenticate, adminOnly, async (req, res) => {
  try {
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


// ============================================================
// PATCH /host-status — Toggle Activity Host Mode visibility
// Body: { hostActive: Boolean }
// Only affects discovery visibility; does NOT remove host profile
// ============================================================
router.patch('/host-status', authenticate, async (req, res) => {
  try {
    const { hostActive } = req.body;

    if (typeof hostActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'hostActive must be a boolean value'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Only companions can toggle host mode
    if (user.userType !== 'COMPANION') {
      return res.status(403).json({
        success: false,
        message: 'Only Activity Hosts can toggle host mode'
      });
    }

    user.hostActive = hostActive;
    await user.save();

    // Auto-expire pending booking requests if host is going offline
    if (!hostActive) {
      try {
        const Booking = require('../models/Booking');
        await Booking.updateMany(
          { companion: req.userId, status: 'pending' },
          { status: 'expired', expiredReason: 'host_went_offline' }
        );
      } catch (_) {
        // Non-critical — bookings model may have different path; continue
      }
    }

    res.json({
      success: true,
      hostActive: user.hostActive,
      message: hostActive
        ? "You're now visible for activity bookings."
        : "Hosting paused. You're no longer visible for activity bookings."
    });
  } catch (error) {
    console.error('Host status update error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
