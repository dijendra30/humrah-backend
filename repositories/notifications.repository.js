const LetterNotification = require('../models/LetterNotification');

class NotificationsRepository {
  async findUserActivity(userId, limit = 60) {
    return await LetterNotification.find({ recipientId: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  async countUnread(userId) {
    return await LetterNotification.countDocuments({ recipientId: userId, isRead: false });
  }

  async markAllRead(userId) {
    return await LetterNotification.updateMany(
      { recipientId: userId, isRead: false },
      { $set: { isRead: true } }
    );
  }

  async markRead(userId, notificationId) {
    return await LetterNotification.findOneAndUpdate(
      { _id: notificationId, recipientId: userId },
      { $set: { isRead: true } },
      { new: true }
    );
  }

  async upsertNotification(recipientId, letterId, type, preview = null) {
    const updateData = {
      $inc: { count: 1 },
      $set: { isRead: false },
      $setOnInsert: { recipientId, letterId, type }
    };
    
    if (preview !== null) {
      updateData.$set.preview = preview.substring(0, 150); // limit preview
    }

    return await LetterNotification.findOneAndUpdate(
      { recipientId, letterId, type },
      updateData,
      { upsert: true, new: true }
    );
  }
}

module.exports = new NotificationsRepository();
