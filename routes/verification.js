// routes/verification.js - Real Identity Verification System (FIXED)
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const VerificationSession = require('../models/VerificationSession');
const { uploadVerificationVideo, deleteVideo } = require('../config/cloudinary');
const crypto = require('crypto');
const multer = require('multer');
const { notifyVerificationReview } = require('../services/telegramService');

// =============================================
// MULTER SETUP FOR VIDEO UPLOAD
// =============================================
const upload = multer({
  storage: multer.memoryStorage(), // Note: 50MB max per concurrent upload in Node heap
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit (Increased to safely accommodate CameraX verification videos)
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
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    });
    
    console.log(`✅ [Verification] Session created: ${sessionId} for user ${req.userId}`);
    
    res.json({
      success: true,
      sessionId: session.sessionId,
      instructions: selectedInstructions,
      duration: 6, // 6 seconds max
      expiresIn: 86400 // 24 hours in seconds
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
router.post('/upload-video', auth, (req, res, next) => {
  upload.single('video')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        console.error(`❌ [Upload] File too large error for user ${req.userId}`);
        return res.status(413).json({ 
          success: false, 
          message: 'Verification video is too large. Maximum allowed size is 50 MB.' 
        });
      }
      console.error(`❌ [Upload] Multer error:`, err);
      return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
    } else if (err) {
      console.error(`❌ [Upload] Unknown error:`, err);
      return res.status(500).json({ success: false, message: err.message || 'Unknown upload error' });
    }
    next();
  });
}, async (req, res) => {
  try {
    console.log("========== FORENSIC DIAGNOSTIC LOG (BACKEND) ==========");
    console.log("body keys:", Object.keys(req.body));
    console.log("raw sessionId from body:", req.body.sessionId);
    console.log("type of sessionId:", typeof req.body.sessionId);
    console.log("req.file exists:", !!req.file);
    if (req.file) {
      console.log("size:", req.file.size);
      console.log("mime:", req.file.mimetype);
    }
    console.log("req.userId:", req.userId);
    console.log("=======================================================");

    let { sessionId } = req.body;
    
    // Sometimes Retrofit sends text parts with extra quotes depending on converter
    if (sessionId && sessionId.startsWith('"') && sessionId.endsWith('"')) {
      sessionId = sessionId.replace(/^"|"$/g, '');
      console.log("Cleaned sessionId:", sessionId);
    }

    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No video file provided' 
      });
    }
    
    console.log(`📥 [Upload] Received video for session ${sessionId}`);
    console.log(`👤 [Upload] User ID: ${req.userId}`);
    
    // Verify session exists and belongs to user
    const query = {
      sessionId,
      userId: req.userId
    };
    console.log("Querying MongoDB with:", query);
    
    const session = await VerificationSession.findOne(query);
    
    if (!session) {
      console.log(`❌ [Upload] Session not found AT ALL for this sessionId...`);
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    // Phase 10: IDEMPOTENCY
    // If Android network timed out after successful backend processing, 
    // it will retry. We must return success immediately without re-uploading.
    if (session.status === 'MANUAL_REVIEW' || session.status === 'APPROVED') {
      console.log(`✅ [Upload] Idempotent retry detected for session ${sessionId}, already processed.`);
      return res.json({
        success: true,
        message: 'Video already uploaded successfully. Sent for manual review.',
        sessionId: session.sessionId,
        status: session.status
      });
    }

    if (session.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: `Session cannot be processed in state: ${session.status}`
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
    
    // Hard Validation: Verify public_id and secure_url exist
    if (!cloudinaryResult || !cloudinaryResult.publicId || !cloudinaryResult.url) {
      console.log(`[VIDEO UPLOAD INVALID]`);
      console.log(`[VIDEO UPLOAD ABORTED]`);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve valid video URL from Cloudinary'
      });
    }

    // Update session with Cloudinary details
    session.videoUrl = cloudinaryResult.url;
    session.cloudinaryPublicId = cloudinaryResult.publicId;
    session.cloudinaryUrl = cloudinaryResult.url;
    session.status = 'MANUAL_REVIEW'; // Bypass AI, go straight to manual review
    
    console.log("Saving session:");
    console.log({
       videoUrl: session.videoUrl,
       cloudinaryPublicId: session.cloudinaryPublicId,
       status: session.status
    });

    await session.save();

    // Synchronize User profile status so Android UI knows it's pending review
    const updatedUser = await User.findByIdAndUpdate(
      req.userId,
      { 
        photoVerificationStatus: 'pending',
        verificationStatus: 'pending' 
      },
      { new: true }
    );

    // Notify UI that video was received and is processing
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${req.userId.toString()}`).emit('verification_status_updated', {
        status: 'MANUAL_REVIEW'
      });
    }
    
    // Notify admin team via Telegram (fire and forget)
    if (updatedUser) {
        notifyVerificationReview(updatedUser, session).catch(err => 
            console.error('[Telegram] Failed to notify verification review:', err)
        );
    }
    
    res.json({
      success: true,
      message: 'Video uploaded successfully. Sent for manual review.',
      sessionId: session.sessionId,
      status: 'MANUAL_REVIEW'
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
    user.photoVerificationStatus = 'approved';
    user.photoVerifiedAt = new Date();
    user.photoVerifiedBy = req.userId;
    user.verificationEmbedding = session.faceEmbedding;
    user.verifiedAt = new Date();
    await user.save();

    // ✅ Emit real-time socket event on admin approval
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${user._id.toString()}`).emit('verification_status_updated', {
        status: 'APPROVED',
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
        io.to(`user:${user._id.toString()}`).emit('verification_status_updated', {
          status: 'REJECTED',
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
