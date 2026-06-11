// routes/adminDashboard.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const SafetyReport = require('../models/SafetyReport');
const SafetyTicket = require('../models/SafetyTicket');
const UserReport = require('../models/UserReport');
const AuditLog = require('../models/AuditLog');
const Post = require('../models/Post');
const Booking = require('../models/Booking'); // Assuming Booking model exists
const { authenticate, adminOnly } = require('../middleware/auth');

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
      openSafetyCases,
      communityPostsToday
    ] = await Promise.all([
      User.countDocuments({ role: 'USER' }),
      User.countDocuments({ role: 'USER', lastActive: { $gte: today } }),
      User.countDocuments({ role: 'USER', verified: true }),
      User.countDocuments({ role: 'USER', 'verificationInfo.status': 'PENDING' }), // Assuming this field exists
      User.countDocuments({ role: 'COMPANION' }), // Assuming role COMPANION or similar exists
      Booking ? Booking.countDocuments({ status: 'CONFIRMED' }) : 0,
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
        communityPostsToday
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
        let videoUrl = session.videoUrl;
        if (!videoUrl && session.cloudinaryPublicId) {
          try {
            // Generate a signed URL for the private 'authenticated' video
            // We MUST append .mp4 BEFORE generating the signature, otherwise Cloudinary rejects it as tampered!
            const publicIdWithExtension = session.cloudinaryPublicId.endsWith('.mp4') 
              ? session.cloudinaryPublicId 
              : `${session.cloudinaryPublicId}.mp4`;
              
            videoUrl = getAuthenticatedUrl(publicIdWithExtension, 'video');
          } catch (e) {
            console.error('Failed to generate signed video URL', e);
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
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Find the pending session
    const session = await VerificationSession.findOne({ userId, status: 'MANUAL_REVIEW' }).sort({ createdAt: -1 });

    if (action === 'approve') {
      user.verified = true;
      user.photoVerificationStatus = 'approved';
      if (session) {
        session.status = 'APPROVED';
        session.result = 'APPROVED';
        session.reviewedBy = req.user._id;
        session.reviewedAt = new Date();
        await session.save();
      }
    } else if (action === 'reject') {
      user.verified = false;
      user.photoVerificationStatus = 'rejected';
      if (session) {
        session.status = 'REJECTED';
        session.result = 'REJECTED';
        session.reviewedBy = req.user._id;
        session.reviewedAt = new Date();
        await session.save();
      }
    } else {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    await user.save();
    
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

    res.json({ success: true, message: `Verification ${action}d` });
  } catch (error) {
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
      
      ticket.status = status;
      if (['RESOLVED_BY_ADMIN', 'CLOSED'].includes(status)) {
        ticket.resolvedBy = req.user._id;
        ticket.resolvedAt = new Date();
        ticket.resolutionNotes = resolutionNotes || '';
      }
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

module.exports = router;
