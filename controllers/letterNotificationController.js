// controllers/letterNotificationController.js
// Handles the Humrah Letters Activity Inbox endpoints.
// GET  /api/letters/activity           → paginated inbox for current user
// PATCH /api/letters/activity/read-all → mark every notification read
// PATCH /api/letters/activity/:id/read → mark single notification read

const LetterNotification = require('../models/LetterNotification');

// ── GET /api/letters/activity ─────────────────────────────────────────────────

exports.getActivity = async (req, res) => {
  try {
    const userId = req.userId;

    const notifications = await LetterNotification.find({ recipientId: userId })
      .sort({ createdAt: -1 })
      .limit(60)
      .lean();

    // Build summary counters (aggregate across all notifications, not just unread)
    const summary = { comfortCount: 0, warmthCount: 0, noteCount: 0 };
    const formatted = notifications.map(n => {
      if (n.type === 'comfort') summary.comfortCount += n.count;
      if (n.type === 'warmth')  summary.warmthCount  += n.count;
      if (n.type === 'note')    summary.noteCount    += n.count;

      return {
        _id:      n._id,
        letterId: n.letterId,
        type:     n.type,
        preview:  n.preview,
        count:    n.count,
        isRead:   n.isRead,
        createdAt: n.createdAt
      };
    });

    return res.status(200).json({ success: true, notifications: formatted, summary });
  } catch (err) {
    console.error('[letterNotif] getActivity error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch activity' });
  }
};

// ── PATCH /api/letters/activity/read-all ─────────────────────────────────────

exports.markAllRead = async (req, res) => {
  try {
    await LetterNotification.updateMany(
      { recipientId: req.userId, isRead: false },
      { $set: { isRead: true } }
    );
    return res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[letterNotif] markAllRead error:', err);
    return res.status(500).json({ success: false, message: 'Failed to mark all as read' });
  }
};

// ── PATCH /api/letters/activity/:id/read ────────────────────────────────────

exports.markRead = async (req, res) => {
  try {
    const doc = await LetterNotification.findOneAndUpdate(
      { _id: req.params.id, recipientId: req.userId },
      { $set: { isRead: true } },
      { new: true }
    );
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[letterNotif] markRead error:', err);
    return res.status(500).json({ success: false, message: 'Failed to mark as read' });
  }
};
