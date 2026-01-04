// routes/admin.js - Complete Admin Management Routes
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const SafetyReport = require('../models/SafetyReport');
const AuditLog = require('../models/AuditLog');
const { authenticate, authorize, superAdminOnly, adminOnly, auditLog } = require('../middleware/auth');

// ==================== DASHBOARD ====================

/**
 * @route   GET /api/admin/dashboard/stats
 * @desc    Get admin dashboard statistics
 * @access  Private (Admin only)
 */
router.get('/dashboard/stats', authenticate, adminOnly, async (req, res) => {
  try {
    const [
      totalUsers,
      activeUsers,
      pendingReports,
      underReviewReports,
      urgentReports,
      suspendedUsers,
      bannedUsers
    ] = await Promise.all([
      User.countDocuments({ role: 'USER' }),
      User.countDocuments({
        role: 'USER',
        lastActive: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }),
      SafetyReport.countDocuments({ status: 'PENDING' }),
      SafetyReport.countDocuments({ status: 'UNDER_REVIEW' }),
      SafetyReport.countDocuments({ priority: { $in: ['URGENT', 'CRITICAL'] }, status: { $in: ['PENDING', 'UNDER_REVIEW'] } }),
      User.countDocuments({ 'suspensionInfo.isSuspended': true }),
      User.countDocuments({ 'banInfo.isBanned': true })
    ]);

    res.json({
      totalUsers,
      activeUsers,
      pendingReports,
      underReviewReports,
      urgentReports,
      suspendedUsers,
      bannedUsers,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load dashboard stats'
    });
  }
});

// ==================== USER MANAGEMENT ====================

/**
 * @route   GET /api/admin/users
 * @desc    Get all users (Admin only)
 * @access  Private (Admin)
 */
router.get('/users', authenticate, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    
    const query = { role: 'USER' };
    
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      users,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalUsers: total
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load users'
    });
  }
});

/**
 * @route   POST /api/admin/users/warn
 * @desc    Warn a user
 * @access  Private (Admin)
 */
router.post('/users/warn', authenticate, adminOnly, auditLog('WARN_USER', 'USER'), async (req, res) => {
  try {
    const { userId, reason, reportId, notifyUser = true } = req.body;

    if (!userId || !reason) {
      return res.status(400).json({
        success: false,
        message: 'User ID and reason are required'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Add warning to user's admin notes
    user.adminNotes = user.adminNotes || [];
    user.adminNotes.push({
      note: `WARNING: ${reason}`,
      createdBy: req.userId,
      createdAt: new Date()
    });

    await user.save();

    // If linked to report, add action
    if (reportId) {
      const report = await SafetyReport.findById(reportId);
      if (report) {
        await report.addAction('WARN', req.userId, reason);
      }
    }

    res.json({
      success: true,
      message: 'User warned successfully',
      action: {
        type: 'WARN',
        performedBy: req.userId,
        reason,
        timestamp: new Date()
      }
    });

  } catch (error) {
    console.error('Warn user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to warn user'
    });
  }
});

/**
 * @route   POST /api/admin/users/suspend
 * @desc    Suspend a user
 * @access  Private (Admin)
 */
router.post('/users/suspend', authenticate, adminOnly, auditLog('SUSPEND_USER', 'USER'), async (req, res) => {
  try {
    const { userId, reason, duration, restrictions = [], reportId, notifyUser = true } = req.body;

    if (!userId || !reason || !duration) {
      return res.status(400).json({
        success: false,
        message: 'User ID, reason, and duration are required'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Calculate suspension end date
    let suspendedUntil = null;
    if (duration !== 'permanent') {
      const days = parseInt(duration.replace('d', ''));
      suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    // Set suspension info
    user.suspensionInfo = {
      isSuspended: true,
      suspendedAt: new Date(),
      suspendedUntil,
      suspensionReason: reason,
      suspendedBy: req.userId,
      restrictions: restrictions || []
    };

    user.status = 'SUSPENDED';
    await user.save();

    // If linked to report, add action
    if (reportId) {
      const report = await SafetyReport.findById(reportId);
      if (report) {
        await report.addAction('SUSPEND', req.userId, reason, duration);
      }
    }

    res.json({
      success: true,
      message: 'User suspended successfully',
      action: {
        type: 'SUSPEND',
        duration,
        until: suspendedUntil,
        performedBy: req.userId,
        reason
      }
    });

  } catch (error) {
    console.error('Suspend user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to suspend user'
    });
  }
});

/**
 * @route   POST /api/admin/users/ban
 * @desc    Ban a user (SUPER_ADMIN only)
 * @access  Private (Super Admin)
 */
router.post('/users/ban', authenticate, superAdminOnly, auditLog('BAN_USER', 'USER'), async (req, res) => {
  try {
    const { userId, reason, isPermanent = true, reportId, deleteUserContent = false } = req.body;

    if (!userId || !reason) {
      return res.status(400).json({
        success: false,
        message: 'User ID and reason are required'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Set ban info
    user.banInfo = {
      isBanned: true,
      bannedAt: new Date(),
      bannedBy: req.userId,
      banReason: reason,
      isPermanent
    };

    user.status = 'BANNED';
    await user.save();

    // If linked to report, add action
    if (reportId) {
      const report = await SafetyReport.findById(reportId);
      if (report) {
        await report.addAction('BAN', req.userId, reason, isPermanent ? 'permanent' : undefined);
      }
    }

    res.json({
      success: true,
      message: 'User banned successfully',
      action: {
        type: 'BAN',
        isPermanent,
        performedBy: req.userId,
        reason
      }
    });

  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to ban user'
    });
  }
});

/**
 * @route   DELETE /api/admin/users/:userId/suspend
 * @desc    Remove suspension
 * @access  Private (Admin)
 */
router.delete('/users/:userId/suspend', authenticate, adminOnly, auditLog('UNSUSPEND_USER', 'USER'), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.suspensionInfo = {
      isSuspended: false
    };
    user.status = 'ACTIVE';
    await user.save();

    res.json({
      success: true,
      message: 'Suspension removed successfully'
    });

  } catch (error) {
    console.error('Unsuspend user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unsuspend user'
    });
  }
});

/**
 * @route   DELETE /api/admin/users/:userId/ban
 * @desc    Remove ban (SUPER_ADMIN only)
 * @access  Private (Super Admin)
 */
router.delete('/users/:userId/ban', authenticate, superAdminOnly, auditLog('UNBAN_USER', 'USER'), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.banInfo = {
      isBanned: false
    };
    user.status = 'ACTIVE';
    await user.save();

    res.json({
      success: true,
      message: 'Ban removed successfully'
    });

  } catch (error) {
    console.error('Unban user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unban user'
    });
  }
});

/**
 * @route   GET /api/admin/users/:userId/full-profile
 * @desc    Get full user profile with admin details
 * @access  Private (Admin)
 */
router.get('/users/:userId/full-profile', authenticate, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const [reports, reportsAgainst] = await Promise.all([
      SafetyReport.find({ reporterId: user._id }).populate('reportedUserId', 'firstName lastName'),
      SafetyReport.find({ reportedUserId: user._id }).populate('reporterId', 'firstName lastName')
    ]);

    res.json({
      success: true,
      user,
      statistics: {
        totalReports: reports.length,
        reportsAgainst: reportsAgainst.length,
        accountAge: Math.floor((new Date() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24)) + ' days'
      },
      reports: reportsAgainst,
      actions: user.adminNotes || []
    });

  } catch (error) {
    console.error('Get full profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load user profile'
    });
  }
});

// ==================== ADMIN MANAGEMENT (SUPER_ADMIN ONLY) ====================

/**
 * @route   GET /api/admin/admins
 * @desc    Get all admins
 * @access  Private (Super Admin)
 */
router.get('/admins', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { role } = req.query;
    
    const query = { role: { $in: ['SAFETY_ADMIN', 'SUPER_ADMIN'] } };
    if (role) {
      query.role = role;
    }

    const admins = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      admins,
      totalCount: admins.length
    });

  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load admins'
    });
  }
});

/**
 * @route   POST /api/admin/admins/create
 * @desc    Create new admin
 * @access  Private (Super Admin)
 */
router.post('/admins/create', authenticate, superAdminOnly, auditLog('CREATE_ADMIN', 'ADMIN'), async (req, res) => {
  try {
    const { email, firstName, lastName, role, permissions } = req.body;

    if (!email || !firstName || !lastName || !role) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    if (!['SAFETY_ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role'
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists'
      });
    }

    const tempPassword = Math.random().toString(36).slice(-8);

    const admin = new User({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password: tempPassword,
      role,
      emailVerified: true,
      verified: true,
      adminPermissions: permissions,
      createdBy: req.userId,
      status: 'ACTIVE'
    });

    await admin.save();

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      user: {
        _id: admin._id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        role: admin.role,
        tempPassword
      }
    });

  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create admin'
    });
  }
});

/**
 * @route   PUT /api/admin/admins/permissions
 * @desc    Update admin permissions
 * @access  Private (Super Admin)
 */
router.put('/admins/permissions', authenticate, superAdminOnly, auditLog('UPDATE_ADMIN_PERMISSIONS', 'ADMIN'), async (req, res) => {
  try {
    const { adminId, permissions } = req.body;

    if (!adminId || !permissions) {
      return res.status(400).json({
        success: false,
        message: 'Admin ID and permissions are required'
      });
    }

    const admin = await User.findById(adminId);
    if (!admin || !admin.isAdmin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    admin.adminPermissions = {
      ...admin.adminPermissions,
      ...permissions
    };

    await admin.save();

    res.json({
      success: true,
      message: 'Permissions updated successfully',
      user: admin
    });

  } catch (error) {
    console.error('Update permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update permissions'
    });
  }
});

/**
 * @route   PUT /api/admin/admins/:adminId/disable
 * @desc    Disable admin account
 * @access  Private (Super Admin)
 */
router.put('/admins/:adminId/disable', authenticate, superAdminOnly, auditLog('DISABLE_ADMIN', 'ADMIN'), async (req, res) => {
  try {
    const admin = await User.findById(req.params.adminId);
    
    if (!admin || !admin.isAdmin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    admin.status = 'SUSPENDED';
    await admin.save();

    res.json({
      success: true,
      message: 'Admin disabled successfully',
      user: admin
    });

  } catch (error) {
    console.error('Disable admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to disable admin'
    });
  }
});

/**
 * @route   PUT /api/admin/admins/:adminId/enable
 * @desc    Enable admin account
 * @access  Private (Super Admin)
 */
router.put('/admins/:adminId/enable', authenticate, superAdminOnly, auditLog('ENABLE_ADMIN', 'ADMIN'), async (req, res) => {
  try {
    const admin = await User.findById(req.params.adminId);
    
    if (!admin || !admin.isAdmin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    admin.status = 'ACTIVE';
    await admin.save();

    res.json({
      success: true,
      message: 'Admin enabled successfully',
      user: admin
    });

  } catch (error) {
    console.error('Enable admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to enable admin'
    });
  }
});

// ==================== AUDIT LOGS ====================

/**
 * @route   GET /api/admin/audit-logs
 * @desc    Get audit logs
 * @access  Private (Super Admin)
 */
router.get('/audit-logs', authenticate, superAdminOnly, async (req, res) => {
  try {
    const {
      adminId,
      action,
      startDate,
      endDate,
      page = 1,
      limit = 50
    } = req.query;

    const query = {};
    
    if (adminId) query.actorId = adminId;
    if (action) query.action = action;
    
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const logs = await AuditLog.find(query)
      .populate('actorId', 'firstName lastName email')
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await AuditLog.countDocuments(query);

    res.json({
      success: true,
      logs,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        total
      }
    });

  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load audit logs'
    });
  }
});

module.exports = router;
