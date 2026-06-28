const LetterReply = require('../models/LetterReply');
const mongoose = require('mongoose');

class RepliesRepository {
  async create(data) {
    const reply = new LetterReply(data);
    return await reply.save();
  }

  async findByLetterId(letterId, limit = 50) {
    if (!mongoose.Types.ObjectId.isValid(letterId)) return [];
    return await LetterReply.find({ letterId, isModerated: false })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  }

  async countUserRepliesToday(userId, startOfDay) {
    return await LetterReply.countDocuments({
      author: userId,
      createdAt: { $gte: startOfDay }
    });
  }

  async getLatestUserReply(userId) {
    return await LetterReply.findOne({ author: userId }).sort({ createdAt: -1 }).lean();
  }
}

module.exports = new RepliesRepository();
