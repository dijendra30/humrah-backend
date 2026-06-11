// routes/safetyReports.js
// Auth is applied globally in server.js — DO NOT add auth per-route here.
// Admin routes are protected with adminOnly from middleware/auth.js.

const express      = require('express');
const router       = express.Router();
const SafetyReport = require('../models/SafetyReport');
const { adminOnly } = require('../middleware/auth');
const { upload, uploadBuffer } = require('../config/cloudinary');

// ==================== USER ENDPOINTS ====================

// POST /api/safety/reports
router.post('/reports', async (req, res) => {
    try {
        const { reportedUserId, category, description, evidenceUrls, contactPreference } = req.body;

        if (!category) {
            return res.status(400).json({ success: false, message: 'Category is required' });
        }

        if (contactPreference?.phone && !contactPreference?.phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required when phone contact is selected'
            });
        }

        const report = await SafetyReport.create({
            reporterId:        req.userId,
            reportedUserId:    reportedUserId || null,
            category,
            description:       description?.trim(),
            evidenceUrls:      evidenceUrls || [],
            contactPreference: contactPreference || {},
            isGeneralReport:   !reportedUserId
        });

        console.log(`🛡️ Safety Report Created:`, {
            reportId:     report._id,
            category:     report.category,
            priority:     report.priority,
            reportedUser: reportedUserId
        });

        res.status(201).json({
            success:  true,
            message:  'Thanks for reporting. Our team will review this and take appropriate action.',
            reportId: report._id.toString(),
            status:   report.status
        });
    } catch (error) {
        console.error('Submit report error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit report' });
    }
});

// POST /api/safety/upload-evidence
router.post('/upload-evidence', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image uploaded' });
        }

        const uploadResult = await uploadBuffer(req.file.buffer, 'humrah/safety-evidence');

        res.json({
            success:      true,
            message:      'Evidence uploaded successfully',
            profilePhoto: uploadResult.url
        });
    } catch (error) {
        console.error('Evidence upload error:', error);
        res.status(500).json({ success: false, message: 'Failed to upload evidence' });
    }
});

// GET /api/safety/my-reports
router.get('/my-reports', async (req, res) => {
    try {
        const page  = parseInt(req.query.page)  || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip  = (page - 1) * limit;

        const [reports, total] = await Promise.all([
            SafetyReport.find({ reporterId: req.userId })
                .sort({ createdAt: -1 })
                .limit(limit)
                .skip(skip)
                .populate('reportedUserId', 'firstName lastName profilePhoto'),
            SafetyReport.countDocuments({ reporterId: req.userId })
        ]);

        res.json({
            success: true,
            reports,
            pagination: {
                currentPage:  page,
                totalPages:   Math.ceil(total / limit),
                totalReports: total
            }
        });
    } catch (error) {
        console.error('Get my reports error:', error);
        res.status(500).json({ success: false, message: 'Failed to load reports' });
    }
});

// ==================== ADMIN ENDPOINTS ====================
// All routes below require adminOnly (SAFETY_ADMIN or SUPER_ADMIN role)

// GET /api/safety/admin/reports
router.get('/admin/reports', adminOnly, async (req, res) => {
    try {
        const { status, priority, category, page = 1, limit = 50 } = req.query;
        const skip  = (page - 1) * limit;
        const query = {};
        if (status)   query.status   = status;
        if (priority) query.priority = priority;
        if (category) query.category = category;

        const [reports, total] = await Promise.all([
            SafetyReport.find(query)
                .sort({ priority: -1, createdAt: -1 })
                .limit(parseInt(limit))
                .skip(skip)
                .populate('reporterId',    'firstName lastName email')
                .populate('reportedUserId', 'firstName lastName email profilePhoto')
                .populate('reviewedBy',    'firstName lastName')
                .select('+reporterId +contactPreference.phoneNumber'),
            SafetyReport.countDocuments(query)
        ]);

        res.json({
            success: true,
            reports,
            pagination: {
                currentPage:  parseInt(page),
                totalPages:   Math.ceil(total / limit),
                totalReports: total
            }
        });
    } catch (error) {
        console.error('Get all reports error:', error);
        res.status(500).json({ success: false, message: 'Failed to load reports' });
    }
});

// GET /api/safety/admin/statistics
router.get('/admin/statistics', adminOnly, async (req, res) => {
    try {
        const [
            totalReports, pendingReports, reviewedReports, actionTakenReports,
            reportsByCategory, reportsByPriority, topReportedUsers
        ] = await Promise.all([
            SafetyReport.countDocuments(),
            SafetyReport.countDocuments({ status: 'PENDING' }),
            SafetyReport.countDocuments({ status: 'REVIEWED' }),
            SafetyReport.countDocuments({ status: 'ACTION_TAKEN' }),
            SafetyReport.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }]),
            SafetyReport.aggregate([{ $group: { _id: '$priority',  count: { $sum: 1 } } }]),
            SafetyReport.aggregate([
                { $group: { _id: '$reportedUserId', count: { $sum: 1 }, latestReport: { $max: '$createdAt' } } },
                { $sort: { count: -1 } },
                { $limit: 10 },
                { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
                { $unwind: '$user' },
                { $project: {
                    userId:           '$_id',
                    userName:         { $concat: ['$user.firstName', ' ', '$user.lastName'] },
                    reportCount:      '$count',
                    latestReportDate: '$latestReport'
                }}
            ])
        ]);

        const toMap = (arr) => arr.reduce((acc, i) => { acc[i._id] = i.count; return acc; }, {});

        res.json({
            totalReports, pendingReports, reviewedReports, actionTakenReports,
            reportsByCategory: toMap(reportsByCategory),
            reportsByPriority: toMap(reportsByPriority),
            topReportedUsers
        });
    } catch (error) {
        console.error('Get statistics error:', error);
        res.status(500).json({ success: false, message: 'Failed to load statistics' });
    }
});

// PUT /api/safety/admin/reports/:reportId
router.put('/admin/reports/:reportId', adminOnly, async (req, res) => {
    try {
        const { status, actionNotes } = req.body;

        const report = await SafetyReport.findById(req.params.reportId);
        if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

        if (status)      report.status     = status;
        if (actionNotes) report.adminNotes = actionNotes;

        if (['REVIEWED', 'ACTION_TAKEN', 'CLOSED'].includes(status)) {
            report.reviewedAt = new Date();
            report.reviewedBy = req.userId;
        }

        await report.save();

        console.log(`🛡️ Report Updated:`, { reportId: report._id, newStatus: report.status, reviewedBy: req.userId });

        res.json({
            success:  true,
            message:  'Report updated successfully',
            reportId: report._id.toString(),
            status:   report.status
        });
    } catch (error) {
        console.error('Update report error:', error);
        res.status(500).json({ success: false, message: 'Failed to update report' });
    }
});

// POST /api/safety/admin/batch-action
router.post('/admin/batch-action', adminOnly, async (req, res) => {
    try {
        const { reportIds, action, actionNotes } = req.body;

        if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Report IDs are required' });
        }

        const update = { status: action, reviewedAt: new Date(), reviewedBy: req.userId };
        if (actionNotes) update.adminNotes = actionNotes;

        await SafetyReport.updateMany({ _id: { $in: reportIds } }, { $set: update });

        console.log(`🛡️ Batch Action:`, { reportCount: reportIds.length, action, adminId: req.userId });

        res.json({ success: true, message: `${reportIds.length} reports updated successfully` });
    } catch (error) {
        console.error('Batch action error:', error);
        res.status(500).json({ success: false, message: 'Failed to perform batch action' });
    }
});

// GET /api/safety/admin/user/:userId/reports
router.get('/admin/user/:userId/reports', adminOnly, async (req, res) => {
    try {
        const reports = await SafetyReport.find({ reportedUserId: req.params.userId })
            .sort({ createdAt: -1 })
            .populate('reporterId',    'firstName lastName email')
            .populate('reportedUserId', 'firstName lastName email profilePhoto')
            .select('+reporterId +contactPreference.phoneNumber');

        res.json({ success: true, reports });
    } catch (error) {
        console.error('Get user reports error:', error);
        res.status(500).json({ success: false, message: 'Failed to load user reports' });
    }
});

module.exports = router;
