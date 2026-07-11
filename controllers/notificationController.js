'use strict';

const Notification = require('../models/Notification');
const Broadcast = require('../models/Broadcast');

/**
 * GET /api/notifications
 * Return the authenticated user's notifications.
 * Query Params: page, limit, unreadOnly
 */
exports.getNotifications = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const unreadOnly = req.query.unreadOnly === 'true';

    const query = { userId: req.user._id };
    if (unreadOnly) {
      query.isRead = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('broadcastId', 'title message type language audienceType expiresAt aiGenerated')
      .lean();

    const total = await Notification.countDocuments(query);

    res.json({
      success: true,
      notifications,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[NotificationController] getNotifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications.' });
  }
};

/**
 * GET /api/notifications/:id
 * Return full notification details.
 */
exports.getNotification = async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).populate('broadcastId').lean();

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.json({ success: true, notification });
  } catch (err) {
    console.error('[NotificationController] getNotification error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch notification.' });
  }
};

/**
 * POST /api/notifications/:id/read
 * Mark the notification as read. Set openedAt.
 * Increment Broadcast.openedCount only once.
 */
exports.markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    if (!notification.isRead) {
      notification.isRead = true;
      notification.openedAt = new Date();
      await notification.save();

      // If it's linked to a Broadcast, increment openedCount
      if (notification.broadcastId) {
        await Broadcast.findByIdAndUpdate(notification.broadcastId, {
          $inc: { openedCount: 1 },
        });
      }
    }

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    console.error('[NotificationController] markAsRead error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark notification as read.' });
  }
};

/**
 * POST /api/notifications/read-all
 * Mark every unread notification as read for the authenticated user.
 */
exports.markAllAsRead = async (req, res) => {
  try {
    const now = new Date();
    
    // We need to find which ones belong to a broadcast to increment counts properly, 
    // but doing an aggregate or multi-update is safer. Let's find unread broadcast notifs first.
    const unreadBroadcastNotifs = await Notification.find({
      userId: req.user._id,
      isRead: false,
      broadcastId: { $ne: null }
    }).select('broadcastId').lean();

    // Group by broadcastId to increment efficiently
    const broadcastCounts = {};
    for (const notif of unreadBroadcastNotifs) {
      const bid = notif.broadcastId.toString();
      broadcastCounts[bid] = (broadcastCounts[bid] || 0) + 1;
    }

    // Mark all as read
    await Notification.updateMany(
      { userId: req.user._id, isRead: false },
      { $set: { isRead: true, openedAt: now } }
    );

    // Increment broadcast opened counts
    for (const [bid, count] of Object.entries(broadcastCounts)) {
      await Broadcast.findByIdAndUpdate(bid, { $inc: { openedCount: count } });
    }

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[NotificationController] markAllAsRead error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark all as read.' });
  }
};

/**
 * GET /api/notifications/unread-count
 * Return only the unread notification count.
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user._id,
      isRead: false,
    });
    res.json({ success: true, unreadCount: count });
  } catch (err) {
    console.error('[NotificationController] getUnreadCount error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch unread count.' });
  }
};
