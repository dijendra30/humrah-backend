const notificationsRepo = require('../repositories/notifications.repository');
const pushService = require('./push.service');

class NotificationsService {
  async getActivitySummaryAndList(userId) {
    const notifications = await notificationsRepo.findUserActivity(userId);
    
    let comfortCount = 0;
    let warmthCount = 0;
    let noteCount = 0;
    let unreadCount = 0;

    const formatted = notifications.map(n => {
      if (n.type === 'comfort' || n.type === 'helped') comfortCount += n.count;
      if (n.type === 'warmth') warmthCount += n.count;
      if (n.type === 'note') noteCount += n.count;
      if (!n.isRead) unreadCount += 1;

      return {
        _id: n._id,
        letterId: n.letterId,
        type: n.type,
        preview: n.preview,
        count: n.count,
        isRead: n.isRead,
        createdAt: n.createdAt
      };
    });

    const summary = { comfortCount, warmthCount, noteCount, unreadCount };
    return { notifications: formatted, summary };
  }

  async getUnreadCount(userId) {
    const count = await notificationsRepo.countUnread(userId);
    return { unreadCount: count };
  }

  async markAllRead(userId) {
    return await notificationsRepo.markAllRead(userId);
  }

  async markRead(userId, notifId) {
    const doc = await notificationsRepo.markRead(userId, notifId);
    return !!doc;
  }

  async notifyNewReaction(recipientId, letterId, type) {
    // type is typically "comfort" or "warmth"
    try {
      const Letter = require('../models/Letter');
      const letter = await Letter.findById(letterId);
      if (!letter || letter.author.toString() !== recipientId.toString()) {
        console.warn('[notifications.service] Ignored push: recipient is not the author');
        return;
      }

      const notification = await notificationsRepo.upsertNotification(recipientId, letterId, type);
      
      if (notification && notification._id) {
        // Increment pending push count for batching
        notification.pendingPushCount += 1;
        await notification.save();
      }
    } catch (err) {
      console.error('[notifications.service] reaction notification error:', err.message);
    }
  }

  async notifyNewNote(recipientId, letterId, previewText) {
    try {
      const Letter = require('../models/Letter');
      const letter = await Letter.findById(letterId);
      if (!letter || letter.author.toString() !== recipientId.toString()) {
        console.warn('[notifications.service] Ignored note push: recipient is not the author');
        return;
      }

      const notification = await notificationsRepo.upsertNotification(recipientId, letterId, 'note', previewText);
      
      // push notification immediately for notes
      if (notification && notification._id) {
        await pushService.sendNoteNotification(recipientId, letterId, notification._id, previewText);
      }
    } catch (err) {
      console.error('[notifications.service] note notification error:', err.message);
    }
  }
}

module.exports = new NotificationsService();
