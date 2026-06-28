const LetterReaction = require('../models/LetterReaction');

class ReactionsRepository {
  async create(data) {
    try {
      const reaction = new LetterReaction(data);
      return await reaction.save();
    } catch (error) {
      // Catch duplicate key error (code 11000) for unique compound index
      if (error.code === 11000) {
        return null;
      }
      throw error;
    }
  }

  async findByUserAndLetter(userId, letterId) {
    return await LetterReaction.findOne({ userId, letterId }).lean();
  }

  async delete(userId, letterId) {
    return await LetterReaction.findOneAndDelete({ userId, letterId }).lean();
  }

  async countUserReactionsToday(userId, startOfDay) {
    return await LetterReaction.countDocuments({
      userId,
      createdAt: { $gte: startOfDay }
    });
  }
}

module.exports = new ReactionsRepository();
