// routes/adminDashboard.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const SafetyReport = require('../models/SafetyReport');
const SafetyTicket = require('../models/SafetyTicket');
const SafetyMessage = require('../models/SafetyMessage');
const UserReport = require('../models/UserReport');
const AuditLog = require('../models/AuditLog');
const Post = require('../models/Post');
const Booking = require('../models/Booking'); // Assuming Booking model exists
const { authenticate, adminOnly } = require('../middleware/auth');
const { deleteImage, deleteVideo } = require('../config/cloudinary');

// 1. Dashboard Stats
router.get('/dashboard/stats', authenticate, adminOnly, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      activeUsersToday,
      verifiedUsers,
      pendingVerifications,
      totalCompanions,
      activeBookings,
      waitingForSafetyTeam,
      connected,
      underReview,
      escalated,
      resolvedToday,
      closedToday,
      openSafetyCases,
      communityPostsToday
    ] = await Promise.all([
      User.countDocuments({ role: 'USER' }),
      User.countDocuments({ role: 'USER', lastActive: { $gte: today } }),
      User.countDocuments({ role: 'USER', verified: true }),
      User.countDocuments({ role: 'USER', 'verificationInfo.status': 'PENDING' }), // Assuming this field exists
      User.countDocuments({ role: 'COMPANION' }), // Assuming role COMPANION or similar exists
      Booking ? Booking.countDocuments({ status: 'CONFIRMED' }) : 0,
      SafetyTicket.countDocuments({ status: 'WAITING_FOR_SAFETY_TEAM' }),
      SafetyTicket.countDocuments({ status: 'SAFETY_TEAM_CONNECTED' }),
      SafetyTicket.countDocuments({ status: 'UNDER_REVIEW' }),
      SafetyTicket.countDocuments({ status: 'ESCALATED' }),
      SafetyTicket.countDocuments({ status: { $in: ['RESOLVED_BY_ADMIN', 'RESOLVED_BY_USER', 'AUTO_RESOLVED', 'RESOLVED_BY_TEAM', 'RESOLVED'] }, updatedAt: { $gte: today } }),
      SafetyTicket.countDocuments({ status: 'CLOSED', updatedAt: { $gte: today } }),
      SafetyReport.countDocuments({ status: { $in: ['PENDING', 'UNDER_REVIEW'] } }),
      Post.countDocuments({ createdAt: { $gte: today } })
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsersToday,
        verifiedUsers,
        pendingVerifications,
        totalCompanions,
        activeBookings,
        openSafetyCases,
        communityPostsToday,
        safetyDashboard: {
          waitingForSafetyTeam,
          connected,
          underReview,
          escalated,
          resolvedToday,
          closedToday
        }
      }
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats' });
  }
});

const VerificationSession = require('../models/VerificationSession');

// 2. Verifications Center Analytics & Pending
router.get('/verifications/analytics', authenticate, adminOnly, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({ role: 'USER' });
    const approved = await VerificationSession.countDocuments({ status: 'APPROVED' });
    const pending = await VerificationSession.countDocuments({ status: 'MANUAL_REVIEW' });
    const rejected = await VerificationSession.countDocuments({ status: 'REJECTED' });
    
    // Funnel data
    const submitted = approved + pending + rejected;
    const funnel = [
      { name: "Total Users", value: totalUsers },
      { name: "Attempted Verification", value: submitted },
      { name: "Approved", value: approved }
    ];

    res.json({ success: true, analytics: { approved, pending, rejected, funnel } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch verification analytics' });
  }
});

const { getAuthenticatedUrl } = require('../config/cloudinary');

router.get('/verifications/pending', authenticate, adminOnly, async (req, res) => {
  try {
    const sessions = await VerificationSession.find({ status: 'MANUAL_REVIEW' })
      .populate('userId', 'firstName lastName email profilePhoto')
      .sort({ createdAt: -1 });
      
    const formatted = sessions
      .filter(session => session.userId)
      .map(session => {
        console.log("Verification session:");
        console.log(session);

        console.log("videoUrl:", session.videoUrl);
        console.log("cloudinaryPublicId:", session.cloudinaryPublicId);

        // ✅ FIX: Videos are uploaded as type:'authenticated' in Cloudinary, so
        // session.videoUrl (the raw secure_url) is NOT directly playable in a
        // browser.  We must ALWAYS generate a signed URL from cloudinaryPublicId.
        // The old guard `if (!videoUrl && ...)` was dead code because videoUrl
        // was always set — meaning the signed-URL path was never reached.
        let videoUrl = null;
        if (session.cloudinaryPublicId) {
          try {
            // Must append .mp4 BEFORE signing — Cloudinary treats extension as
            // part of the signed payload and rejects mismatches.
            const publicIdWithExtension = session.cloudinaryPublicId.endsWith('.mp4')
              ? session.cloudinaryPublicId
              : `${session.cloudinaryPublicId}.mp4`;

            videoUrl = getAuthenticatedUrl(publicIdWithExtension, 'video');
            console.log("Generated signed videoUrl:", videoUrl);
          } catch (e) {
            console.error('Failed to generate signed video URL', e);
            // Fallback to raw stored URL (won't play for authenticated resources,
            // but better than nothing for debugging)
            videoUrl = session.videoUrl || null;
          }
        }

        return {
          _id: session.userId._id, // User ID for backwards compatibility
          sessionId: session._id,
          firstName: session.userId.firstName,
          lastName: session.userId.lastName,
          email: session.userId.email,
          profilePhoto: session.userId.profilePhoto,
          verificationVideoUrl: videoUrl,
          createdAt: session.createdAt
        };
      });
    
    res.json({ success: true, verifications: formatted });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch pending verifications' });
  }
});

// Approve/Reject Verification
router.post('/verifications/:userId/:action', authenticate, adminOnly, async (req, res) => {
  try {
    const { userId, action } = req.params;
    const { reason } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Find the pending session
    const session = await VerificationSession.findOne({ userId, status: 'MANUAL_REVIEW' }).sort({ createdAt: -1 });

    if (action === 'approve') {
      user.verified = true;
      user.photoVerificationStatus = 'approved';
      user.photoVerifiedAt = new Date();
      if (session) {
        session.status = 'APPROVED';
        session.result = 'APPROVED';
        session.reviewedBy = req.user._id;
        session.reviewedAt = new Date();
      }
    } else if (action === 'reject') {
      user.verified = false;
      user.photoVerificationStatus = 'rejected';
      if (reason) {
        user.photoRejectionReason = reason;
        if (session) session.rejectionReason = reason;
      }
      if (session) {
        session.status = 'REJECTED';
        session.result = 'REJECTED';
        session.reviewedBy = req.user._id;
        session.reviewedAt = new Date();
      }
    } else {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    // Capture media IDs for async cleanup before clearing them from DB
    const photoIdToDelete = user.verificationPhotoPublicId;
    const videoIdToDelete = session ? session.cloudinaryPublicId : null;
    console.log(`[Admin Review] Loaded User photoIdToDelete: ${photoIdToDelete}`);
    console.log(`[Admin Review] Loaded Session videoIdToDelete: ${videoIdToDelete}`);

    // Clear DB fields immediately
    if (photoIdToDelete) {
      user.verificationPhoto = null;
      user.verificationPhotoPublicId = null;
    }
    if (session && videoIdToDelete) {
      console.log(`[BEFORE CLEANUP] session.cloudinaryPublicId = ${session.cloudinaryPublicId}`);
      session.videoUrl = null;
      session.cloudinaryPublicId = null;
    }
    user.verificationMediaDeletedAt = new Date();

    await user.save();
    if (session) {
      await session.save();
      console.log(`[SESSION AFTER CLEANUP]`, {
        sessionId: session._id,
        status: session.status,
        cloudinaryPublicId: session.cloudinaryPublicId,
        videoUrl: session.videoUrl
      });
    }
    console.log(`[CLEANUP SUCCESS] Successfully cleared media fields from MongoDB for user ${user._id}`);
    
    // Log action safely
    if (AuditLog && AuditLog.logAction) {
      await AuditLog.logAction({
        actorId: req.user._id,
        actorRole: req.user.role || 'SUPER_ADMIN',
        actorEmail: req.user.email,
        action: 'UPDATE_USER_STATUS',
        targetType: 'USER',
        targetId: user._id,
        targetEmail: user.email,
        targetName: `${user.firstName} ${user.lastName}`,
        details: { action: action === 'approve' ? 'VERIFICATION_APPROVAL' : 'VERIFICATION_REJECTION' },
        ipAddress: req.ip
      });
    }

    res.json({ success: true, message: `Verification ${action}d. Verification media securely deleted.` });

    // --- FCM NOTIFICATIONS ---
    setImmediate(async () => {
      try {
        const { sendDataFcm } = require('../utils/fcmHelper');
        if (!user.fcmTokens || user.fcmTokens.length === 0) {
          console.log(`[FCM TOKEN MISSING] No FCM tokens found for user ${user._id}`);
          return;
        }
        
        console.log(`[FCM TOKEN FOUND] ${user.fcmTokens.length} tokens for user ${user._id}`);
        console.log(`[FCM SEND START] Dispatching ${action} notification to user ${user._id}`);

        const notificationData = {
          type: action === 'approve' ? 'verification_approved' : 'verification_rejected',
          title: action === 'approve' ? '🎉 Verification Approved' : 'Verification Update',
          body: action === 'approve' 
            ? 'Your photo verification has been approved. You can now access verified member features.'
            : 'Your verification could not be approved. Please review the requirements and submit again.',
          userId: user._id.toString()
        };

        await sendDataFcm(user._id.toString(), user.fcmTokens, notificationData);
        console.log(`[FCM RESPONSE] Successfully processed FCM dispatch for user ${user._id}`);
      } catch (fcmError) {
        console.error(`[FCM ERROR] Failed to send verification FCM to user ${user._id}:`, fcmError.message);
      }
    });

    // --- ASYNC CLEANUP ---
    setImmediate(async () => {
      const deleteWithRetry = async (deleteFn, publicId, type, retries = 1) => {
        if (!publicId) return;
        for (let i = 0; i <= retries; i++) {
          try {
            await deleteFn(publicId);
            console.log(`[Verification Cleanup] Successfully deleted ${type}: ${publicId}`);
            return;
          } catch (error) {
            console.error(`[Verification Cleanup] Failed to delete ${type}: ${publicId} (Attempt ${i + 1}). Error:`, error.message);
            if (i === retries) {
              console.error(`[Verification Cleanup] Max retries reached for ${publicId}. Affected User ID: ${userId}`);
            }
          }
        }
      };

      if (photoIdToDelete) {
        await deleteWithRetry(deleteImage, photoIdToDelete, 'photo');
      }
      if (videoIdToDelete) {
        await deleteWithRetry(deleteVideo, videoIdToDelete, 'video');
      }
    });

  } catch (error) {
    console.error('Verification review error:', error);
    res.status(500).json({ success: false, message: 'Failed to process verification' });
  }
});

// 3. Companion Applications (Simplified)
router.get('/companions/applications', authenticate, adminOnly, async (req, res) => {
  try {
    // Assuming there is a field or status for companion applications
    const companions = await User.find({ role: 'COMPANION', status: 'PENDING_APPROVAL' })
      .select('firstName lastName email profilePhoto companionDetails status');
    res.json({ success: true, applications: companions });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch companion applications' });
  }
});

// 4. Reports & Safety Cases Aggregator
router.get('/reports/all', authenticate, adminOnly, async (req, res) => {
  try {
    const [safetyTickets, userReports] = await Promise.all([
      SafetyTicket.find()
        .populate('reporterId', 'firstName lastName email profilePhoto')
        .populate('reportedUserId', 'firstName lastName email profilePhoto')
        .sort({ createdAt: -1 })
        .limit(100),
      UserReport.find()
        .populate('reporterId', 'firstName lastName email profilePhoto')
        .populate('reportedUserId', 'firstName lastName email profilePhoto')
        .sort({ createdAt: -1 })
        .limit(100)
    ]);

    // Normalize formatting for the frontend table
    const normalizedTickets = safetyTickets.map(t => ({
      _id: t._id,
      type: 'SAFETY_TICKET',
      typeLabel: 'Safety Ticket',
      reporter: t.reporterId,
      reportedUser: t.reportedUserId,
      reason: t.concernType,
      description: t.note,
      status: t.status,
      riskLevel: t.riskLevel,
      geminiSummary: t.geminiSummary,
      createdAt: t.createdAt,
      raw: t
    }));

    const normalizedUserReports = userReports.map(r => ({
      _id: r._id,
      type: 'USER_REPORT',
      typeLabel: 'User Report',
      reporter: r.reporterId,
      reportedUser: r.reportedUserId,
      reason: r.reason,
      description: r.description,
      status: 'OPEN', // UserReports don't have status out of the box, map as OPEN
      riskLevel: 'LOW',
      createdAt: r.createdAt,
      raw: r
    }));

    const combined = [...normalizedTickets, ...normalizedUserReports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, reports: combined });
  } catch (error) {
    console.error('Fetch reports error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch reports' });
  }
});

// Update Report/Ticket Status
router.post('/reports/:type/:id/status', authenticate, adminOnly, async (req, res) => {
  try {
    const { type, id } = req.params;
    const { status, resolutionNotes } = req.body;

    if (type === 'SAFETY_TICKET') {
      const ticket = await SafetyTicket.findById(id);
      if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
      
      if (['RESOLVED_BY_ADMIN', 'CLOSED'].includes(status)) {
        if (!resolutionNotes || !resolutionNotes.trim()) {
          return res.status(400).json({ success: false, message: 'Resolution notes are required when resolving or closing a ticket.' });
        }
        ticket.resolvedBy = req.user._id;
        ticket.resolvedAt = new Date();
        ticket.resolutionNotes = resolutionNotes.trim();
      }
      ticket.status = status;
      await ticket.save();

      // Log safely
      if (AuditLog && AuditLog.logAction) {
        await AuditLog.logAction({
          actorId: req.user._id,
          actorRole: req.user.role || 'SUPER_ADMIN',
          actorEmail: req.user.email,
          action: 'UPDATE_REPORT_STATUS',
          targetType: 'REPORT',
          targetId: ticket._id,
          details: { status, resolutionNotes },
          ipAddress: req.ip
        });
      }
    } else {
      // For UserReports, since they don't have a status schema natively, we'll just log it.
      // Or we can delete it if "CLOSED". For now, we'll return a mock success or delete.
      if (status === 'CLOSED' || status === 'RESOLVED_BY_ADMIN') {
        await UserReport.findByIdAndDelete(id);
      }
    }

    res.json({ success: true, message: 'Status updated successfully' });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});
// ============================================================================
// ADMIN SAFETY CHAT OPERATIONS
// ============================================================================

// 1. Connect to Safety Chat
router.post('/reports/safety-ticket/:id/connect', authenticate, adminOnly, async (req, res) => {
  try {
    const ticket = await SafetyTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    if (ticket.status !== 'SAFETY_TEAM_CONNECTED') {
      ticket.status = 'SAFETY_TEAM_CONNECTED';
      ticket.connectedBy = req.user._id;
      ticket.connectedAt = new Date();
      await ticket.save();

      // Send system message
      await SafetyMessage.create({
        ticketId: ticket._id,
        content: 'Humrah Safety Team has joined this conversation and is reviewing your report.',
        isFromTeam: true,
        isSystem: true
      });

      // Audit Log
      if (AuditLog && AuditLog.logAction) {
        await AuditLog.logAction({
          actorId: req.user._id,
          actorRole: req.user.role || 'SUPER_ADMIN',
          actorEmail: req.user.email,
          action: 'CONNECTED_TO_CHAT',
          targetType: 'REPORT',
          targetId: ticket._id,
          details: { ticketId: ticket.ticketId },
          ipAddress: req.ip
        });
      }
    }

    res.json({ success: true, message: 'Connected to chat' });
  } catch (error) {
    console.error('Connect chat error:', error);
    res.status(500).json({ success: false, message: 'Failed to connect to chat' });
  }
});

// 2. Fetch Chat Messages & Internal Notes
router.get('/reports/safety-ticket/:id/messages', authenticate, adminOnly, async (req, res) => {
  try {
    const ticket = await SafetyTicket.findById(req.params.id)
      .populate('reporterId', 'firstName lastName email lastActive isOnline')
      .populate('connectedBy', 'firstName lastName')
      .populate('resolvedBy', 'firstName lastName')
      .lean();
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const messages = await SafetyMessage.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).lean();
    
    // Get last message time from user
    const lastUserMessage = messages.filter(m => !m.isFromTeam).pop();
    const lastMessageTime = lastUserMessage ? lastUserMessage.createdAt : null;

    res.json({ 
      success: true, 
      messages,
      internalNotes: ticket.internalNotes || [],
      ticketDetails: {
        ticketId: ticket.ticketId,
        riskLevel: ticket.riskLevel,
        status: ticket.status,
        createdTime: ticket.createdAt,
        connectedTime: ticket.connectedAt,
        assignedAdmin: ticket.connectedBy ? `${ticket.connectedBy.firstName} ${ticket.connectedBy.lastName}` : null,
        resolvedBy: ticket.resolvedBy ? `${ticket.resolvedBy.firstName} ${ticket.resolvedBy.lastName}` : null,
        resolutionNotes: ticket.resolutionNotes
      },
      userPresence: {
        userName: ticket.reporterId ? `${ticket.reporterId.firstName} ${ticket.reporterId.lastName}` : 'Unknown',
        isOnline: ticket.reporterId ? ticket.reporterId.isOnline : false,
        lastSeen: ticket.reporterId ? ticket.reporterId.lastActive : null,
        lastMessageTime: lastMessageTime,
        sharedLocation: ticket.sharedLocation || null
      }
    });
  } catch (error) {
    console.error('Fetch messages error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch messages' });
  }
});

// 3. Send Message to User
router.post('/reports/safety-ticket/:id/messages', authenticate, adminOnly, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'Message content required' });

    const ticket = await SafetyTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const msg = await SafetyMessage.create({
      ticketId: ticket._id,
      senderId: req.user._id,
      content: content.trim(),
      isFromTeam: true,
      isSystem: false
    });

    // Audit Log
    if (AuditLog && AuditLog.logAction) {
      await AuditLog.logAction({
        actorId: req.user._id,
        actorRole: req.user.role || 'SUPER_ADMIN',
        actorEmail: req.user.email,
        action: 'SENT_MESSAGE',
        targetType: 'REPORT',
        targetId: ticket._id,
        details: { ticketId: ticket.ticketId },
        ipAddress: req.ip
      });
    }

    res.json({ success: true, message: msg });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

// 4. Add Internal Note
router.post('/reports/safety-ticket/:id/internal-notes', authenticate, adminOnly, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ success: false, message: 'Note content required' });

    const ticket = await SafetyTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    ticket.internalNotes.push({
      adminId: req.user._id,
      adminName: req.user.firstName + (req.user.lastName ? ' ' + req.user.lastName : ''),
      note: note.trim(),
      createdAt: new Date()
    });

    await ticket.save();

    res.json({ success: true, internalNotes: ticket.internalNotes });
  } catch (error) {
    console.error('Add internal note error:', error);
    res.status(500).json({ success: false, message: 'Failed to add internal note' });
  }
});

module.exports = router;
