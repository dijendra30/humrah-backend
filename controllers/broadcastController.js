// controllers/broadcastController.js — Broadcast Notification System (Phase 1)
// Thin controller layer — delegates business logic to services.

'use strict';

const Broadcast        = require('../models/Broadcast');
const Notification     = require('../models/Notification');
const broadcastService = require('../services/broadcastService');
const broadcastAi      = require('../services/broadcastAiService');

// =============================================
// CREATE BROADCAST (DRAFT)
// =============================================

/**
 * POST /api/admin/broadcasts
 * Create a new broadcast in DRAFT status.
 */
exports.createBroadcast = async (req, res) => {
  try {
    const {
      title, message, type, audienceType, language,
      targetState, targetCity, targetArea,
      onlyVerifiedUsers, onlyPremiumUsers, expiresAt,
    } = req.body;

    const broadcast = await Broadcast.create({
      title,
      message,
      type:              type || 'ANNOUNCEMENT',
      audienceType,
      language:          language || 'en',
      targetState:       targetState || null,
      targetCity:        targetCity || null,
      targetArea:        targetArea || null,
      onlyVerifiedUsers: onlyVerifiedUsers || false,
      onlyPremiumUsers:  onlyPremiumUsers || false,
      expiresAt:         expiresAt || null,
      createdBy:         req.user._id,
      status:            'DRAFT',
    });

    console.log(`[Broadcast] Created broadcast ${broadcast._id} by admin ${req.user.email}`);

    return res.status(201).json({
      success: true,
      message: 'Broadcast created as draft',
      broadcast,
    });
  } catch (err) {
    console.error('[Broadcast] createBroadcast error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to create broadcast',
    });
  }
};

// =============================================
// GET BROADCAST LIST
// =============================================

/**
 * GET /api/admin/broadcasts
 * Paginated list with optional filters: status, type, date range.
 */
exports.getBroadcastList = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      type,
      startDate,
      endDate,
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (type)   query.type = type;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate)   query.createdAt.$lte = new Date(endDate);
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const [broadcasts, total] = await Promise.all([
      Broadcast.find(query)
        .populate('createdBy', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .lean(),
      Broadcast.countDocuments(query),
    ]);

    return res.json({
      success: true,
      broadcasts,
      pagination: {
        page:       parseInt(page, 10),
        limit:      parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    });
  } catch (err) {
    console.error('[Broadcast] getBroadcastList error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch broadcasts',
    });
  }
};

// =============================================
// GET BROADCAST DETAILS
// =============================================

/**
 * GET /api/admin/broadcasts/:id
 * Single broadcast with delivery analytics.
 */
exports.getBroadcastDetails = async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id)
      .populate('createdBy', 'firstName lastName email')
      .lean();

    if (!broadcast) {
      return res.status(404).json({
        success: false,
        message: 'Broadcast not found',
      });
    }

    // Compute real-time delivery stats from notification records
    const [deliveredCount, openedCount] = await Promise.all([
      Notification.countDocuments({ broadcastId: broadcast._id, deliveredAt: { $ne: null } }),
      Notification.countDocuments({ broadcastId: broadcast._id, openedAt: { $ne: null } }),
    ]);

    return res.json({
      success: true,
      broadcast: {
        ...broadcast,
        analytics: {
          totalRecipients: broadcast.totalRecipients,
          deliveredCount,
          failedCount:     broadcast.failedCount,
          openedCount,
          deliveryRate:    broadcast.totalRecipients > 0
            ? ((deliveredCount / broadcast.totalRecipients) * 100).toFixed(1)
            : '0.0',
          openRate:        deliveredCount > 0
            ? ((openedCount / deliveredCount) * 100).toFixed(1)
            : '0.0',
        },
      },
    });
  } catch (err) {
    console.error('[Broadcast] getBroadcastDetails error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch broadcast details',
    });
  }
};

// =============================================
// UPDATE DRAFT
// =============================================

/**
 * PUT /api/admin/broadcasts/:id
 * Update a broadcast only if it is still in DRAFT status.
 */
exports.updateDraft = async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);

    if (!broadcast) {
      return res.status(404).json({
        success: false,
        message: 'Broadcast not found',
      });
    }

    if (broadcast.status !== 'DRAFT') {
      return res.status(400).json({
        success: false,
        message: `Cannot edit a broadcast with status "${broadcast.status}". Only DRAFT broadcasts can be updated.`,
      });
    }

    // Only update provided fields
    const allowedFields = [
      'title', 'message', 'type', 'audienceType', 'language',
      'targetState', 'targetCity', 'targetArea',
      'onlyVerifiedUsers', 'onlyPremiumUsers', 'expiresAt', 'aiGenerated',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        broadcast[field] = req.body[field];
      }
    }

    await broadcast.save();

    console.log(`[Broadcast] Updated draft ${broadcast._id} by admin ${req.user.email}`);

    return res.json({
      success: true,
      message: 'Broadcast draft updated',
      broadcast,
    });
  } catch (err) {
    console.error('[Broadcast] updateDraft error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update broadcast',
    });
  }
};

// =============================================
// DELETE BROADCAST
// =============================================

/**
 * DELETE /api/admin/broadcasts/:id
 * Delete a broadcast. Only DRAFT and FAILED can be deleted.
 */
exports.deleteBroadcast = async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);

    if (!broadcast) {
      return res.status(404).json({
        success: false,
        message: 'Broadcast not found',
      });
    }

    if (!['DRAFT', 'FAILED'].includes(broadcast.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete a broadcast with status "${broadcast.status}". Only DRAFT or FAILED broadcasts can be deleted.`,
      });
    }

    await Broadcast.findByIdAndDelete(broadcast._id);

    // Clean up any notification records (in case of a FAILED broadcast that had partial sends)
    await Notification.deleteMany({ broadcastId: broadcast._id });

    console.log(`[Broadcast] Deleted broadcast ${broadcast._id} by admin ${req.user.email}`);

    return res.json({
      success: true,
      message: 'Broadcast deleted',
    });
  } catch (err) {
    console.error('[Broadcast] deleteBroadcast error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete broadcast',
    });
  }
};

// =============================================
// SEND BROADCAST
// =============================================

/**
 * POST /api/admin/broadcasts/:id/send
 * Trigger sending a DRAFT broadcast to its audience.
 */
exports.sendBroadcast = async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);

    if (!broadcast) {
      return res.status(404).json({
        success: false,
        message: 'Broadcast not found',
      });
    }

    if (broadcast.status !== 'DRAFT') {
      return res.status(400).json({
        success: false,
        message: `Cannot send broadcast with status "${broadcast.status}". Only DRAFT broadcasts can be sent.`,
      });
    }

    // Quick audience check before starting the send
    const audienceInfo = await broadcastService.getAudienceCount({
      audienceType:      broadcast.audienceType,
      targetState:       broadcast.targetState,
      targetCity:        broadcast.targetCity,
      targetArea:        broadcast.targetArea,
      onlyVerifiedUsers: broadcast.onlyVerifiedUsers,
      onlyPremiumUsers:  broadcast.onlyPremiumUsers,
    });

    if (audienceInfo.count === 0) {
      return res.status(400).json({
        success: false,
        message: 'No eligible recipients found for this audience. Broadcast not sent.',
        audience: audienceInfo.summary,
      });
    }

    console.log(`[Broadcast] Sending broadcast ${broadcast._id} to ${audienceInfo.count} recipients by admin ${req.user.email}`);

    // Send asynchronously — respond immediately so admin doesn't wait
    // The broadcast status will be updated to SENT or FAILED once complete.
    broadcastService.sendToAudience(broadcast._id).catch(err => {
      console.error(`[Broadcast] Async send failed for ${broadcast._id}:`, err.message);
    });

    return res.json({
      success: true,
      message: `Broadcast is being sent to ${audienceInfo.count} recipient(s). Check broadcast details for delivery status.`,
      broadcastId: broadcast._id,
      estimatedRecipients: audienceInfo.count,
    });
  } catch (err) {
    console.error('[Broadcast] sendBroadcast error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to send broadcast',
    });
  }
};

// =============================================
// TEST BROADCAST (Phase 2)
// =============================================

/**
 * POST /api/admin/broadcasts/:id/test
 * Sends the broadcast ONLY to the current admin user for testing.
 */
exports.testBroadcast = async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);

    if (!broadcast) {
      return res.status(404).json({
        success: false,
        message: 'Broadcast not found',
      });
    }

    const payload = {
      title: broadcast.title,
      body:  broadcast.message,
      data: {
        type:        'ADMIN_BROADCAST',
        broadcastId: broadcast._id.toString(),
        isTest:      'true'
      },
    };

    // Send only to req.user._id (the admin requesting the test)
    const broadcastFcm = require('../services/broadcastFcmService');
    const result = await broadcastFcm.sendToSingleUser(req.user._id, payload);

    if (result.success) {
      console.log(`[Broadcast] Test broadcast ${broadcast._id} sent to admin ${req.user.email}`);
      return res.json({
        success: true,
        message: 'Test notification sent to your device',
      });
    } else {
      console.warn(`[Broadcast] Test broadcast failed for admin ${req.user.email}: ${result.reason}`);
      return res.status(400).json({
        success: false,
        message: `Failed to send test notification: ${result.reason === 'no_tokens' ? 'No FCM tokens found for your account.' : result.reason}`,
      });
    }
  } catch (err) {
    console.error('[Broadcast] testBroadcast error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to send test broadcast',
    });
  }
};

// =============================================
// TEST BROADCAST (Phase 2)
// =============================================

/**
 * POST /api/admin/broadcasts/:id/test
 * Sends the broadcast ONLY to the current admin user for testing.
 */
exports.testBroadcast = async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);

    if (!broadcast) {
      return res.status(404).json({
        success: false,
        message: 'Broadcast not found',
      });
    }

    const payload = {
      title: broadcast.title,
      body:  broadcast.message,
      data: {
        type:        'ADMIN_BROADCAST',
        broadcastId: broadcast._id.toString(),
        isTest:      'true'
      },
    };

    // Send only to req.user._id (the admin requesting the test)
    const broadcastFcm = require('../services/broadcastFcmService');
    const result = await broadcastFcm.sendToSingleUser(req.user._id, payload);

    if (result.success) {
      console.log(`[Broadcast] Test broadcast ${broadcast._id} sent to admin ${req.user.email}`);
      return res.json({
        success: true,
        message: 'Test notification sent to your device',
      });
    } else {
      console.warn(`[Broadcast] Test broadcast failed for admin ${req.user.email}: ${result.reason}`);
      return res.status(400).json({
        success: false,
        message: `Failed to send test notification: ${result.reason === 'no_tokens' ? 'No FCM tokens found for your account.' : result.reason}`,
      });
    }
  } catch (err) {
    console.error('[Broadcast] testBroadcast error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to send test broadcast',
    });
  }
};

// =============================================
// PREVIEW BROADCAST AUDIENCE
// =============================================

/**
 * POST /api/admin/broadcasts/preview
 * Preview audience size and applied filters without sending.
 */
exports.previewBroadcastAudience = async (req, res) => {
  try {
    const {
      audienceType, targetState, targetCity, targetArea,
      onlyVerifiedUsers, onlyPremiumUsers,
    } = req.body;

    const audienceInfo = await broadcastService.getAudienceCount({
      audienceType,
      targetState:       targetState || null,
      targetCity:        targetCity || null,
      targetArea:        targetArea || null,
      onlyVerifiedUsers: onlyVerifiedUsers || false,
      onlyPremiumUsers:  onlyPremiumUsers || false,
    });

    // Build a summary of applied filters for the admin
    const appliedFilters = { audienceType };
    if (targetState) appliedFilters.targetState = targetState;
    if (targetCity)  appliedFilters.targetCity = targetCity;
    if (targetArea)  appliedFilters.targetArea = targetArea;
    if (onlyVerifiedUsers) appliedFilters.onlyVerifiedUsers = true;
    if (onlyPremiumUsers)  appliedFilters.onlyPremiumUsers = true;

    return res.json({
      success: true,
      estimatedRecipients: audienceInfo.count,
      appliedFilters,
      audienceSummary: audienceInfo.summary,
    });
  } catch (err) {
    console.error('[Broadcast] previewBroadcastAudience error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to preview audience',
    });
  }
};

// =============================================
// AI REPHRASE
// =============================================

/**
 * POST /api/admin/broadcasts/ai-rephrase
 * Call Gemini AI to rephrase broadcast content.
 * AI is only invoked when this endpoint is explicitly called — never automatically.
 */
exports.aiRephrase = async (req, res) => {
  try {
    const { title, message, tone, language } = req.body;

    console.log(`[Broadcast] AI rephrase requested by admin ${req.user.email}. Tone: ${tone}`);

    const result = await broadcastAi.rephraseContent({ title, message, tone, language: language || 'en' });

    console.log(`[Broadcast] AI rephrase completed successfully.`);

    return res.json({
      success: true,
      message: 'Content rephrased successfully',
      ...result,
    });
  } catch (err) {
    // AI errors are propagated clearly — no silent fallback
    console.error('[Broadcast] aiRephrase error:', err.message);

    const statusCode = err.message.includes('timed out') ? 504
      : err.message.includes('not configured') ? 503
      : err.message.includes('AI service error') ? 502
      : 500;

    return res.status(statusCode).json({
      success: false,
      message: err.message,
    });
  }
};

// =============================================
// BROADCAST DRAFTS & HISTORY
// =============================================

exports.getDrafts = async (req, res) => {
  req.query.status = 'DRAFT';
  return exports.getBroadcastList(req, res);
};

exports.getHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const query = { status: { $in: ['SENDING', 'SENT', 'FAILED', 'CANCELLED'] } };
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    
    const [broadcasts, total] = await Promise.all([
      Broadcast.find(query)
        .populate('createdBy', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .lean(),
      Broadcast.countDocuments(query),
    ]);
    
    return res.json({
      success: true,
      broadcasts,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    });
  } catch (err) {
    console.error('[Broadcast] getHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
};

// =============================================
// BROADCAST ANALYTICS
// =============================================

exports.getAnalytics = async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id)
      .populate('createdBy', 'firstName lastName email')
      .lean();

    if (!broadcast) {
      return res.status(404).json({ success: false, message: 'Broadcast not found' });
    }

    const notifications = await Notification.find({ broadcastId: broadcast._id }).lean();
    
    let deliveredCount = 0;
    let openedCount = 0;
    let clickedCount = 0;
    let pendingCount = 0;
    let failedCount = broadcast.failedCount || 0;
    
    const deliveryTimeline = [];
    const openTimeline = [];
    const failureBreakdown = {};
    const androidVersions = {};
    const appVersions = {};

    notifications.forEach(n => {
      if (n.deliveredAt) {
        deliveredCount++;
        deliveryTimeline.push({ time: n.deliveredAt });
      } else if (n.failureReason) {
        failedCount++;
        failureBreakdown[n.failureReason] = (failureBreakdown[n.failureReason] || 0) + 1;
      } else {
        pendingCount++;
      }
      
      if (n.openedAt) {
        openedCount++;
        openTimeline.push({ time: n.openedAt });
      }

      if (n.clickedAt) {
        clickedCount++;
      }
      
      if (n.androidVersion) androidVersions[n.androidVersion] = (androidVersions[n.androidVersion] || 0) + 1;
      if (n.appVersion) appVersions[n.appVersion] = (appVersions[n.appVersion] || 0) + 1;
    });
    
    return res.json({
      success: true,
      analytics: {
        general: broadcast,
        delivery: {
          totalRecipients: broadcast.totalRecipients,
          delivered: deliveredCount,
          failed: failedCount,
          pending: pendingCount,
          deliveryRate: broadcast.totalRecipients > 0 ? ((deliveredCount / broadcast.totalRecipients) * 100).toFixed(1) : 0
        },
        engagement: {
          opened: openedCount,
          clicked: clickedCount,
          notOpened: deliveredCount - openedCount,
          openRate: deliveredCount > 0 ? ((openedCount / deliveredCount) * 100).toFixed(1) : 0,
          readRate: deliveredCount > 0 ? ((openedCount / deliveredCount) * 100).toFixed(1) : 0,
          clickThroughRate: deliveredCount > 0 ? ((clickedCount / deliveredCount) * 100).toFixed(1) : 0
        },
        android: {
          versions: androidVersions,
          apps: appVersions,
          devicesReached: deliveredCount
        },
        failures: failureBreakdown,
        charts: {
          deliveryTimeline,
          openTimeline
        }
      }
    });

  } catch (err) {
    console.error('[Broadcast] getAnalytics error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
  }
};

// =============================================
// SCHEDULE BROADCAST
// =============================================

exports.scheduleBroadcast = async (req, res) => {
  try {
    const { scheduledFor } = req.body;
    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: 'scheduledFor date is required' });
    }

    const broadcast = await Broadcast.findById(req.params.id);
    if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });
    
    if (broadcast.status !== 'DRAFT') {
      return res.status(400).json({ success: false, message: 'Only DRAFT broadcasts can be scheduled' });
    }

    broadcast.status = 'SCHEDULED';
    broadcast.scheduledFor = new Date(scheduledFor);
    await broadcast.save();

    console.log(`[Broadcast] Scheduled ${broadcast._id} for ${broadcast.scheduledFor}`);
    
    return res.json({ success: true, message: 'Broadcast scheduled', broadcast });
  } catch (err) {
    console.error('[Broadcast] scheduleBroadcast error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to schedule broadcast' });
  }
};
