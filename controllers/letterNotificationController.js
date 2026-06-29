// controllers/letterNotificationController.js
// Handles the Humrah Letters Activity Inbox endpoints.
// GET  /api/letters/activity           → paginated inbox for current user
// PATCH /api/letters/activity/read-all → mark every notification read
// PATCH /api/letters/activity/:id/read → mark single notification read

const notificationsService = require('../services/notifications.service');

// ── GET /api/letters/activity/unread-count ────────────────────────────────────

exports.getUnreadCount = async (req, res) => {
  try {
    const data = await notificationsService.getUnreadCount(req.userId);
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error('[letterNotif] getUnreadCount error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch unread count' });
  }
};

// ── GET /api/letters/activity ─────────────────────────────────────────────────

exports.getActivity = async (req, res) => {
  try {
    const data = await notificationsService.getActivitySummaryAndList(req.userId);
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error('[letterNotif] getActivity error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch activity' });
  }
};

// ── PATCH /api/letters/activity/read-all ─────────────────────────────────────

exports.markAllRead = async (req, res) => {
  try {
    await notificationsService.markAllRead(req.userId);
    return res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[letterNotif] markAllRead error:', err);
    return res.status(500).json({ success: false, message: 'Failed to mark all as read' });
  }
};

// ── PATCH /api/letters/activity/:id/read ────────────────────────────────────

exports.markRead = async (req, res) => {
  try {
    const success = await notificationsService.markRead(req.userId, req.params.id);
    if (!success) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[letterNotif] markRead error:', err);
    return res.status(500).json({ success: false, message: 'Failed to mark as read' });
  }
};
