// routes/verification.js - Real Identity Verification System
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const VerificationSession = require('../models/VerificationSession');
const { cloudinary } = require('../config/cloudinary');
const crypto = require('crypto');
const axios = require('axios');
const { processVerificationVideo } = require('../services/verificationProcessor');

// =============================================
// VERIFICATION INSTRUCTIONS POOL
// =============================================
const VERIFICATION_INSTRUCTIONS = [
  'Turn your head slowly to the left',
  'Turn your head slowly to the right',
  'Blink twice',
  'Smile naturally',
  'Look up slightly',
  'Nod your head once'
];

// =============================================
// START VERIFICATION SESSION
// =============================================
// @route   POST /api/verification/start
// @desc    Start a new verification session with randomized instructions
// @access  Private
router.post('/start', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if user already verified
    if (user.verified) {
      return res.status(400).json({
        success: false,
        message: 'User is already verified'
      });
    }
    
    // Check for pending verification
    const pendingSession = await VerificationSession.findOne({
      userId: req.userId,
      status: 'PENDING',
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } // Last 10 minutes
    });
    
    if (pendingSession) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending verification session',
        sessionId: pendingSession.sessionId
      });
    }
    
    // Generate unique session ID
    const sessionId = crypto.randomBytes(16).toString('hex');
    
    // Randomize instructions (pick 3-4 random instructions)
    const shuffled = [...VERIFICATION_INSTRUCTIONS].sort(() => Math.random() - 0.5);
    const selectedInstructions = shuffled.slice(0, Math.floor(Math.random() * 2) + 3); // 3-4 instructions
    
    // Create verification session
    const session = await VerificationSession.create({
      userId: req.userId,
      sessionId,
      instructions: selectedInstructions,
      status: 'PENDING',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    });
    
    res.json({
      success: true,
      sessionId: session.sessionId,
      instructions: selectedInstructions,
      duration: 6, // 6 seconds max
      expiresIn: 600 // 10 minutes in seconds
    });
    
  } catch (error) {
    console.error('Start verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start verification session'
    });
  }
});

// =============================================
// GENERATE CLOUDINARY SIGNATURE
// =============================================
// @route   POST /api/verification/upload-signature
// @desc    Generate signed upload parameters for Cloudinary
// @access  Private
router.post('/upload-signature', auth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Session ID is required'
      });
    }
    
    // Verify session exists and belongs to user
    const session = await VerificationSession.findOne({
      sessionId,
      userId: req.userId,
      status: 'PENDING'
    });
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired verification session'
      });
    }
    
    // Check if session expired
    if (new Date() > session.expiresAt) {
      session.status = 'EXPIRED';
      await session.save();
      
      return res.status(400).json({
        success: false,
        message: 'Verification session expired'
      });
    }
    
    const timestamp = Math.round(Date.now() / 1000);
    const folder = `verification-temp/${sessionId}`;
    
    // Parameters for Cloudinary upload
    const uploadParams = {
      timestamp,
      folder,
      resource_type: 'video',
      type: 'authenticated', // Private, not public
      invalidate: true,
      eager: '', // No transformations
      eager_async: false,
      backup: false,
      overwrite: false
    };
    
    // Generate signature
    const stringToSign = Object.keys(uploadParams)
      .sort()
      .map(key => `${key}=${uploadParams[key]}`)
      .join('&');
    
    const signature = crypto
      .createHash('sha1')
      .update(stringToSign + process.env.CLOUDINARY_API_SECRET)
      .digest('hex');
    
    res.json({
      success: true,
      uploadParams: {
        ...uploadParams,
        signature,
        api_key: process.env.CLOUDINARY_API_KEY,
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME
      }
    });
    
  } catch (error) {
    console.error('Generate signature error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate upload signature'
    });
  }
});

// =============================================
// PROCESS VERIFICATION VIDEO
// =============================================
// @route   POST /api/verification/process
// @desc    Process uploaded verification video
// @access  Private
router.post('/process', auth, async (req, res) => {
  try {
    const { sessionId, publicId } = req.body;
    
    if (!sessionId || !publicId) {
      return res.status(400).json({
        success: false,
        message: 'Session ID and public ID are required'
      });
    }
    
    // Find session
    const session = await VerificationSession.findOne({
      sessionId,
      userId: req.userId,
      status: 'PENDING'
    });
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Invalid verification session'
      });
    }
    
    // Update session with publicId
    session.cloudinaryPublicId = publicId;
    session.status = 'PROCESSING';
    await session.save();
    
    // Process asynchronously (don't wait for user)
    processVerificationInBackground(session._id, req.userId, publicId, sessionId);
    
    res.json({
      success: true,
      message: 'Verification video is being processed',
      status: 'PROCESSING'
    });
    
  } catch (error) {
    console.error('Process verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process verification'
    });
  }
});

// =============================================
// CHECK VERIFICATION STATUS
// =============================================
// @route   GET /api/verification/status/:sessionId
// @desc    Check status of verification session
// @access  Private
router.get('/status/:sessionId', auth, async (req, res) => {
  try {
    const session = await VerificationSession.findOne({
      sessionId: req.params.sessionId,
      userId: req.userId
    });
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Verification session not found'
      });
    }
    
    res.json({
      success: true,
      status: session.status,
      result: session.result,
      confidence: session.confidence,
      rejectionReason: session.rejectionReason,
      processedAt: session.processedAt,
      createdAt: session.createdAt
    });
    
  } catch (error) {
    console.error('Check status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check verification status'
    });
  }
});

// =============================================
// BACKGROUND PROCESSING FUNCTION (UPDATED)
// =============================================
async function processVerificationInBackground(sessionId, userId, publicId, sessionToken) {
  try {
    console.log(`\n🎬 [Verification] Starting background processing for session ${sessionToken}`);
    
    const session = await VerificationSession.findById(sessionId);
    const user = await User.findById(userId);
    
    if (!session || !user) {
      console.error('[Verification] Session or user not found');
      return;
    }
    
    // =============================================
    // CALL THE VERIFICATION PROCESSOR
    // =============================================
    const result = await processVerificationVideo(publicId, user, session);
    
    // =============================================
    // UPDATE SESSION WITH RESULTS
    // =============================================
    session.status = result.decision;
    session.result = result.decision;
    session.confidence = result.confidence;
    session.livenessScore = result.livenessScore;
    session.faceMatchScore = result.faceMatchScore;
    session.rejectionReason = result.rejectionReason;
    session.processedAt = new Date();
    
    // =============================================
    // HANDLE APPROVAL
    // =============================================
    if (result.decision === 'APPROVED') {
      session.faceEmbedding = result.faceEmbedding;
      
      // Mark user as verified
      await user.markVerifiedViaVideo(result.faceEmbedding);
      
      console.log(`✅ [Verification] User ${user._id} APPROVED and marked as verified`);
      
      // TODO: Send success notification to user
      await sendVerificationResultNotification(user, 'APPROVED');
    }
    
    // =============================================
    // HANDLE REJECTION
    // =============================================
    else if (result.decision === 'REJECTED') {
      await user.recordVerificationRejection(result.rejectionReason, session.sessionId);
      
      console.log(`❌ [Verification] User ${user._id} REJECTED: ${result.rejectionReason}`);
      
      // TODO: Send rejection notification to user
      await sendVerificationResultNotification(user, 'REJECTED', result.rejectionReason);
    }
    
    // =============================================
    // HANDLE MANUAL REVIEW
    // =============================================
    else if (result.decision === 'MANUAL_REVIEW') {
      session.faceEmbedding = result.faceEmbedding; // Save for manual review
      
      console.log(`⚠️ [Verification] User ${user._id} needs MANUAL REVIEW`);
      
      // TODO: Notify admins about pending review
      await notifyAdminsForManualReview(session, user);
    }
    
    await session.save();
    
    // =============================================
    // DELETE VIDEO FROM CLOUDINARY (CRITICAL)
    // =============================================
    await deleteVerificationVideo(publicId);
    session.videoDeletedAt = new Date();
    await session.save();
    
    console.log(`\n✅ [Verification] Processing complete for session ${sessionToken}`);
    console.log(`   Final Decision: ${result.decision}`);
    console.log(`   Video Deleted: Yes`);
    
  } catch (error) {
    console.error('❌ [Verification] Background processing error:', error);
    
    // Update session to failed state
    try {
      const session = await VerificationSession.findById(sessionId);
      if (session) {
        session.status = 'FAILED';
        session.rejectionReason = 'Processing error occurred';
        session.processedAt = new Date();
        await session.save();
      }
    } catch (updateError) {
      console.error('[Verification] Failed to update session:', updateError);
    }
    
    // Still try to delete the video
    try {
      await deleteVerificationVideo(publicId);
    } catch (deleteError) {
      console.error('[Verification] Failed to delete video:', deleteError);
    }
  }
}

// =============================================
// GET USER VERIFICATION HISTORY (Admin)
// =============================================
// @route   GET /api/verification/history/:userId
// @desc    Get verification history for a user (Admin only)
// @access  Private (Admin)
router.get('/history/:userId', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'SAFETY_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const sessions = await VerificationSession.find({
      userId: req.params.userId
    })
    .sort({ createdAt: -1 })
    .select('-faceEmbedding') // Don't expose embeddings
    .limit(20);
    
    res.json({
      success: true,
      sessions
    });
    
  } catch (error) {
    console.error('Get verification history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// MANUAL REVIEW ENDPOINTS (Admin)
// =============================================

// Get pending manual reviews
router.get('/admin/pending-reviews', auth, async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'SAFETY_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const pendingSessions = await VerificationSession.find({
      status: 'MANUAL_REVIEW'
    })
    .populate('userId', 'firstName lastName email profilePhoto')
    .sort({ createdAt: -1 })
    .limit(50);
    
    res.json({
      success: true,
      sessions: pendingSessions
    });
    
  } catch (error) {
    console.error('Get pending reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Approve verification manually
router.post('/admin/approve/:sessionId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'SAFETY_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const session = await VerificationSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    const user = await User.findById(session.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Update session
    session.status = 'APPROVED';
    session.result = 'APPROVED';
    session.reviewedBy = req.userId;
    session.reviewedAt = new Date();
    await session.save();
    
    // Update user
    user.verified = true;
    user.verificationEmbedding = session.faceEmbedding;
    user.verifiedAt = new Date();
    await user.save();
    
    res.json({
      success: true,
      message: 'Verification approved'
    });
    
  } catch (error) {
    console.error('Approve verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Reject verification manually
router.post('/admin/reject/:sessionId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'SAFETY_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const { reason } = req.body;
    
    const session = await VerificationSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Update session
    session.status = 'REJECTED';
    session.result = 'REJECTED';
    session.rejectionReason = reason || 'Manually rejected by admin';
    session.reviewedBy = req.userId;
    session.reviewedAt = new Date();
    await session.save();
    
    res.json({
      success: true,
      message: 'Verification rejected'
    });
    
  } catch (error) {
    console.error('Reject verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});
// =============================================
// NOTIFICATION HELPERS
// =============================================

/**
 * Send verification result notification to user
 */
async function sendVerificationResultNotification(user, result, reason = null) {
  try {
    // Only send if user has FCM tokens
    if (!user.fcmTokens || user.fcmTokens.length === 0) {
      console.log('ℹ️ No FCM tokens for user, skipping notification');
      return;
    }
    
    const admin = require('firebase-admin');
    
    let title, body;
    
    if (result === 'APPROVED') {
      title = '✅ Verification Approved!';
      body = 'Your identity has been verified. You now have full access to Humrah.';
    } else if (result === 'REJECTED') {
      title = '❌ Verification Failed';
      body = reason || 'Your verification was unsuccessful. Please try again.';
    } else if (result === 'MANUAL_REVIEW') {
      title = '⏳ Verification Under Review';
      body = 'Your verification is being manually reviewed. You will be notified soon.';
    }
    
    const message = {
      notification: { title, body },
      data: {
        type: 'VERIFICATION_RESULT',
        result: result,
        reason: reason || ''
      },
      tokens: user.fcmTokens
    };
    
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`📱 Verification notification sent: ${response.successCount}/${user.fcmTokens.length}`);
    
  } catch (error) {
    console.error('❌ Failed to send verification notification:', error);
  }
}

/**
 * Notify admins about pending manual review
 */
async function notifyAdminsForManualReview(session, user) {
  try {
    // Find all admin users
    const User = require('../models/User');
    const admins = await User.find({
      role: { $in: ['SAFETY_ADMIN', 'SUPER_ADMIN'] },
      fcmTokens: { $exists: true, $ne: [] }
    });
    
    if (admins.length === 0) {
      console.log('ℹ️ No admins to notify');
      return;
    }
    
    const admin = require('firebase-admin');
    
    for (const adminUser of admins) {
      const message = {
        notification: {
          title: '⚠️ Manual Verification Required',
          body: `${user.firstName} ${user.lastName} needs manual review`
        },
        data: {
          type: 'MANUAL_REVIEW_PENDING',
          sessionId: session.sessionId,
          userId: user._id.toString()
        },
        tokens: adminUser.fcmTokens
      };
      
      await admin.messaging().sendEachForMulticast(message);
    }
    
    console.log(`📱 Notified ${admins.length} admins about manual review`);
    
  } catch (error) {
    console.error('❌ Failed to notify admins:', error);
  }
}

module.exports = router;
