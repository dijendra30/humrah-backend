const express = require('express');
const router = express.Router();
const SafetyReport = require('../models/SafetyReport');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');
const { uploadEvidence } = require('../middleware/upload');

// ==================== USER ENDPOINTS ====================

/**
 * @route   POST /api/safety/reports
 * @desc    Submit a safety report
 * @access  Private
 */
router.post('/reports', protect, async (req, res) => {
    try {
        const {
            reportedUserId,
            category,
            description,
            evidenceUrls,
            contactPreference
        } = req.body;
        
        // Validation
        if (!reportedUserId || !category) {
            return res.status(400).json({
                success: false,
                message: 'Reported user and category are required'
            });
        }
        
        // Can't report yourself
        if (reportedUserId === req.user._id.toString()) {
            return res.status(400).json({
                success: false,
                message: 'You cannot report yourself'
            });
        }
        
        // Check if reported user exists
        const reportedUser = await User.findById(reportedUserId);
        if (!reportedUser) {
            return res.status(404).json({
                success: false,
                message: 'Reported user not found'
            });
        }
        
        // Validate phone number if phone contact is selected
        if (contactPreference?.phone && !contactPreference?.phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required when phone contact is selected'
            });
        }
        
        // Create report
        const report = await SafetyReport.create({
            reporterId: req.user._id,
            reportedUserId,
            category,
            description: description?.trim(),
            evidenceUrls: evidenceUrls || [],
            contactPreference: contactPreference || {}
        });
        
        // Send notification to safety team
        // (Implement email/slack notification here)
        
        res.status(201).json({
            success: true,
            message: 'Thanks for reporting. Our team will review this and take appropriate action.',
            reportId: report._id.toString(),
            status: report.status
        });
        
    } catch (error) {
        console.error('Submit report error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit report'
        });
    }
});

/**
 * @route   POST /api/safety/upload-evidence
 * @desc    Upload evidence image
 * @access  Private
 */
router.post('/upload-evidence', protect, uploadEvidence, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No image uploaded'
            });
        }
        
        // Return the uploaded image URL
        res.json({
            success: true,
            message: 'Evidence uploaded successfully',
            profilePhoto: req.file.url // Cloudinary URL
        });
        
    } catch (error) {
        console.error('Evidence upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload evidence'
        });
    }
});

/**
 * @route   GET /api/safety/my-reports
 * @desc    Get user's own reports
 * @access  Private
 */
router.get('/my-reports', protect, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        
        const reports = await SafetyReport.find({ reporterId: req.user._id })
            .sort({ createdAt: -1 })
            .limit(limit)
            .skip(skip)
            .populate('reportedUserId', 'firstName lastName profilePhoto')
            .select('+reporterId'); // Include reporter for own reports
        
        const total = await SafetyReport.countDocuments({ reporterId: req.user._id });
        
        res.json({
            success: true,
            reports,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalReports: total
            }
        });
        
    } catch (error) {
        console.error('Get my reports error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load reports'
        });
    }
});

// ==================== ADMIN ENDPOINTS ====================

/**
 * @route   GET /api/safety/admin/reports
 * @desc    Get all reports (admin only)
 * @access  Private + Admin
 */
router.get('/admin/reports', protect, adminOnly, async (req, res) => {
    try {
        const {
            status,
            priority,
            category,
            page = 1,
            limit = 50
        } = req.query;
        
        const skip = (page - 1) * limit;
        
        // Build query
        const query = {};
        if (status) query.status = status;
        if (priority) query.priority = priority;
        if (category) query.category = category;
        
        const reports = await SafetyReport.find(query)
            .sort({ priority: -1, createdAt: -1 })
            .limit(parseInt(limit))
            .skip(skip)
            .populate('reporterId', 'firstName lastName email')
            .populate('reportedUserId', 'firstName lastName email profilePhoto')
            .populate('reviewedBy', 'firstName lastName')
            .select('+reporterId +contactPreference.phoneNumber'); // Include confidential fields for admin
        
        const total = await SafetyReport.countDocuments(query);
        
        res.json({
            success: true,
            reports,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / limit),
                totalReports: total
            }
        });
        
    } catch (error) {
        console.error('Get all reports error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load reports'
        });
    }
});

/**
 * @route   GET /api/safety/admin/statistics
 * @desc    Get report statistics
 * @access  Private + Admin
 */
router.get('/admin/statistics', protect, adminOnly, async (req, res) => {
    try {
        const [
            totalReports,
            pendingReports,
            reviewedReports,
            actionTakenReports,
            reportsByCategory,
            reportsByPriority,
            topReportedUsers
        ] = await Promise.all([
            SafetyReport.countDocuments(),
            SafetyReport.countDocuments({ status: 'PENDING' }),
            SafetyReport.countDocuments({ status: 'REVIEWED' }),
            SafetyReport.countDocuments({ status: 'ACTION_TAKEN' }),
            
            // Group by category
            SafetyReport.aggregate([
                { $group: { _id: '$category', count: { $sum: 1 } } }
            ]),
            
            // Group by priority
            SafetyReport.aggregate([
                { $group: { _id: '$priority', count: { $sum: 1 } } }
            ]),
            
            // Top reported users
            SafetyReport.aggregate([
                {
                    $group: {
                        _id: '$reportedUserId',
                        count: { $sum: 1 },
                        latestReport: { $max: '$createdAt' }
                    }
                },
                { $sort: { count: -1 } },
                { $limit: 10 },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'user'
                    }
                },
                { $unwind: '$user' },
                {
                    $project: {
                        userId: '$_id',
                        userName: { $concat: ['$user.firstName', ' ', '$user.lastName'] },
                        reportCount: '$count',
                        latestReportDate: '$latestReport'
                    }
                }
            ])
        ]);
        
        // Format results
        const categoryMap = {};
        reportsByCategory.forEach(item => {
            categoryMap[item._id] = item.count;
        });
        
        const priorityMap = {};
        reportsByPriority.forEach(item => {
            priorityMap[item._id] = item.count;
        });
        
        res.json({
            totalReports,
            pendingReports,
            reviewedReports,
            actionTakenReports,
            reportsByCategory: categoryMap,
            reportsByPriority: priorityMap,
            topReportedUsers
        });
        
    } catch (error) {
        console.error('Get statistics error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load statistics'
        });
    }
});

/**
 * @route   PUT /api/safety/admin/reports/:reportId
 * @desc    Update report status
 * @access  Private + Admin
 */
router.put('/admin/reports/:reportId', protect, adminOnly, async (req, res) => {
    try {
        const { status, actionNotes } = req.body;
        
        const report = await SafetyReport.findById(req.params.reportId);
        
        if (!report) {
            return res.status(404).json({
                success: false,
                message: 'Report not found'
            });
        }
        
        // Update report
        if (status) report.status = status;
        if (actionNotes) report.adminNotes = actionNotes;
        
        if (['REVIEWED', 'ACTION_TAKEN', 'CLOSED'].includes(status)) {
            report.reviewedAt = new Date();
            report.reviewedBy = req.user._id;
        }
        
        await report.save();
        
        res.json({
            success: true,
            message: 'Report updated successfully',
            reportId: report._id.toString(),
            status: report.status
        });
        
    } catch (error) {
        console.error('Update report error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update report'
        });
    }
});

/**
 * @route   POST /api/safety/admin/batch-action
 * @desc    Batch action on multiple reports
 * @access  Private + Admin
 */
router.post('/admin/batch-action', protect, adminOnly, async (req, res) => {
    try {
        const { reportIds, action, actionNotes } = req.body;
        
        if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Report IDs are required'
            });
        }
        
        const update = {
            status: action,
            reviewedAt: new Date(),
            reviewedBy: req.user._id
        };
        
        if (actionNotes) {
            update.adminNotes = actionNotes;
        }
        
        await SafetyReport.updateMany(
            { _id: { $in: reportIds } },
            { $set: update }
        );
        
        res.json({
            success: true,
            message: `${reportIds.length} reports updated successfully`
        });
        
    } catch (error) {
        console.error('Batch action error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to perform batch action'
        });
    }
});

/**
 * @route   GET /api/safety/admin/user/:userId/reports
 * @desc    Get all reports for a specific user
 * @access  Private + Admin
 */
router.get('/admin/user/:userId/reports', protect, adminOnly, async (req, res) => {
    try {
        const reports = await SafetyReport.find({ reportedUserId: req.params.userId })
            .sort({ createdAt: -1 })
            .populate('reporterId', 'firstName lastName email')
            .populate('reportedUserId', 'firstName lastName email profilePhoto')
            .select('+reporterId +contactPreference.phoneNumber');
        
        res.json({
            success: true,
            reports
        });
        
    } catch (error) {
        console.error('Get user reports error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load user reports'
        });
    }
});

module.exports = router;
