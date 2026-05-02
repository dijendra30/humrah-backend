// routes/verification.js - Real Identity Verification System (FIXED)
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const VerificationSession = require('../models/VerificationSession');
const { uploadVerificationVideo, deleteVideo } = require('../config/cloudinary');
const crypto = require('crypto');
const multer = require('multer');
const { processVerificationVideo } = require('../services/verificationProcessor');

// =============================================
// MULTER SETUP FOR VIDEO UPLOAD
// =============================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  }
});

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
    
    console.log(`✅ [Verification] Session created: ${sessionId} for user ${req.userId}`);
    
    res.json({
      success: true,
      sessionId: session.sessionId,
      instructions: selectedInstructions,
      duration: 6, // 6 seconds max
      expiresIn: 600 // 10 minutes in seconds
    });
    
  } catch (error) {
    console.error('❌ [Verification] Start session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start verification session'
    });
  }
});

// =============================================
// ✅ NEW: UPLOAD VIDEO ENDPOINT
// =============================================
// @route   POST /api/verification/upload-video
// @desc    Upload verification video from Android
// @access  Private
router.post('/upload-video', auth, upload.single('video'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No video file provided' 
      });
    }
    
    console.log(`📥 [Upload] Received video for session ${sessionId}`);
    console.log(`📦 [Upload] Video size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`👤 [Upload] User ID: ${req.userId}`);
    
    // Verify session exists and belongs to user
    const session = await VerificationSession.findOne({
      sessionId,
      userId: req.userId,
      status: 'PENDING'
    });
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found or already processed'
      });
    }
    
    // Check if session expired
    if (session.isExpired()) {
      session.status = 'EXPIRED';
      await session.save();
      
      return res.status(400).json({
        success: false,
        message: 'Session expired. Please start a new verification.'
      });
    }
    
    // Upload video buffer to Cloudinary
    console.log(`☁️ [Upload] Uploading to Cloudinary...`);
    const cloudinaryResult = await uploadVerificationVideo(
      req.file.buffer,
      sessionId
    );
    
    console.log(`✅ [Upload] Video uploaded: ${cloudinaryResult.publicId}`);
    
    // Update session with Cloudinary details
    session.cloudinaryPublicId = cloudinaryResult.publicId;
    session.cloudinaryUrl = cloudinaryResult.url;
    session.status = 'PROCESSING';
    await session.save();
    
    // Start processing in background (don't wait)
    // ✅ Pass the app's io instance so background job can emit socket events
    const io = req.app.get('io');
    processVerificationInBackground(session._id, req.userId, io);
    
    res.json({
      success: true,
      message: 'Video uploaded successfully. Processing started.',
      sessionId: session.sessionId,
      status: 'PROCESSING'
    });
    
  } catch (error) {
    console.error('❌ [Upload] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload video',
      error: error.message
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
    console.error('❌ [Verification] Check status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check verification status'
    });
  }
});

// =============================================
// BACKGROUND PROCESSING FUNCTION
// =============================================
// ✅ io parameter added — allows emitting real-time socket events to the user
async function processVerificationInBackground(sessionId, userId, io) {
  try {
    console.log(`\n🎬 [Verification] Starting background processing...`);
    
    const session = await VerificationSession.findById(sessionId);
    const user = await User.findById(userId);
    
    if (!session || !user) {
      console.error('❌ [Verification] Session or user not found');
      return;
    }
    
    console.log(`👤 [Verification] Processing for user: ${user.email}`);
    console.log(`📹 [Verification] Video ID: ${session.cloudinaryPublicId}`);
    
    // =============================================
    // CALL THE VERIFICATION PROCESSOR
    // =============================================
    const result = await processVerificationVideo(
      session.cloudinaryPublicId,
      user,
      session
    );
    
    console.log(`📊 [Verification] Processing complete. Decision: ${result.decision}`);
    
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
      
      // Send success notification
      await sendVerificationResultNotification(user, 'APPROVED');

      // ✅ Emit real-time socket event to user's private room
      if (io) {
        io.to(user._id.toString()).emit('verification_status_updated', {
          status: 'approved',
          reviewDeadline: null,
          rejectionReason: null
        });
        console.log(`🔔 [Socket] Emitted approved to user ${user._id}`);
      }
    }
    
    // =============================================
    // HANDLE REJECTION
    // =============================================
    else if (result.decision === 'REJECTED') {
      await user.recordVerificationRejection(result.rejectionReason, session.sessionId);
      
      console.log(`❌ [Verification] User ${user._id} REJECTED: ${result.rejectionReason}`);
      
      // Send rejection notification
      await sendVerificationResultNotification(user, 'REJECTED', result.rejectionReason);

      // ✅ Emit real-time socket event to user's private room
      if (io) {
        io.to(user._id.toString()).emit('verification_status_updated', {
          status: 'rejected',
          reviewDeadline: null,
          rejectionReason: result.rejectionReason || 'Verification rejected'
        });
        console.log(`🔔 [Socket] Emitted rejected to user ${user._id}`);
      }
    }
    
    // =============================================
    // HANDLE MANUAL REVIEW
    // =============================================
    else if (result.decision === 'MANUAL_REVIEW') {
      session.faceEmbedding = result.faceEmbedding;

      // ✅ Stamp review window timestamps on the session
      const now = new Date();
      const reviewDeadline = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24 hours
      session.manualReviewStartedAt = now;
      session.reviewDeadline = reviewDeadline;

      // ✅ FIX: Update user.photoVerificationStatus so REST API reflects correct state
      user.photoVerificationStatus = 'pending';
      user.verificationPhotoSubmittedAt = now;
      await user.save();
      
      console.log(`⚠️ [Verification] User ${user._id} needs MANUAL REVIEW (deadline: ${reviewDeadline.toISOString()})`);
      
      // Notify admins
      await notifyAdminsForManualReview(session, user);

      // ✅ Emit real-time socket event to user's private room
      if (io) {
        io.to(user._id.toString()).emit('verification_status_updated', {
          status: 'pending',
          reviewDeadline: reviewDeadline.toISOString(),
          rejectionReason: null
        });
        console.log(`🔔 [Socket] Emitted pending (manual review) to user ${user._id} (deadline: ${reviewDeadline.toISOString()})`);
      }
    }
    
    await session.save();
    
    // =============================================
    // DELETE VIDEO FROM CLOUDINARY (CRITICAL)
    // =============================================
    try {
      await deleteVideo(session.cloudinaryPublicId);
      session.videoDeletedAt = new Date();
      await session.save();
      console.log(`🗑️ [Verification] Video deleted from Cloudinary`);
    } catch (deleteError) {
      console.error('⚠️ [Verification] Failed to delete video:', deleteError);
    }
    
    console.log(`\n✅ [Verification] Processing complete for session ${session.sessionId}`);
    
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
        
        // Try to delete video even on error
        if (session.cloudinaryPublicId) {
          await deleteVideo(session.cloudinaryPublicId);
        }
      }
    } catch (updateError) {
      console.error('❌ [Verification] Failed to update session:', updateError);
    }
  }
}

// =============================================
// GET USER VERIFICATION HISTORY (Admin)
// =============================================
router.get('/history/:userId', auth, async (req, res) => {
  try {
    // Check if user is admin
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const sessions = await VerificationSession.find({
      userId: req.params.userId
    })
    .sort({ createdAt: -1 })
    .select('-faceEmbedding')
    .limit(20);
    
    res.json({
      success: true,
      sessions
    });
    
  } catch (error) {
    console.error('❌ [Verification] Get history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// MANUAL REVIEW ENDPOINTS (Admin)
// =============================================

router.get('/admin/pending-reviews', auth, async (req, res) => {
  try {
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
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
    console.error('❌ [Verification] Get pending reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.post('/admin/approve/:sessionId', auth, async (req, res) => {
  try {
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
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
    
    session.status = 'APPROVED';
    session.result = 'APPROVED';
    session.reviewedBy = req.userId;
    session.reviewedAt = new Date();
    await session.save();
    
    user.verified = true;
    user.verificationEmbedding = session.faceEmbedding;
    user.verifiedAt = new Date();
    await user.save();

    // ✅ Emit real-time socket event on admin approval
    const io = req.app.get('io');
    if (io) {
      io.to(user._id.toString()).emit('verification_status_updated', {
        status: 'approved',
        reviewDeadline: null,
        rejectionReason: null
      });
      console.log(`🔔 [Socket] Admin approved emitted to user ${user._id}`);
    }
    
    res.json({
      success: true,
      message: 'Verification approved'
    });
    
  } catch (error) {
    console.error('❌ [Verification] Approve error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.post('/admin/reject/:sessionId', auth, async (req, res) => {
  try {
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
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

    const user = await User.findById(session.userId);
    
    session.status = 'REJECTED';
    session.result = 'REJECTED';
    session.rejectionReason = reason || 'Manually rejected by admin';
    session.reviewedBy = req.userId;
    session.reviewedAt = new Date();
    await session.save();

    // ✅ Emit real-time socket event on admin rejection
    if (user) {
      const io = req.app.get('io');
      if (io) {
        io.to(user._id.toString()).emit('verification_status_updated', {
          status: 'rejected',
          reviewDeadline: null,
          rejectionReason: session.rejectionReason
        });
        console.log(`🔔 [Socket] Admin rejected emitted to user ${user._id}`);
      }
    }
    
    res.json({
      success: true,
      message: 'Verification rejected'
    });
    
  } catch (error) {
    console.error('❌ [Verification] Reject error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// NOTIFICATION HELPERS
// =============================================

async function sendVerificationResultNotification(user, result, reason = null) {
  try {
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

async function notifyAdminsForManualReview(session, user) {
  try {
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
