const Letter = require('../models/Letter');
const mongoose = require('mongoose');

class LettersRepository {
  async create(data) {
    const letter = new Letter(data);
    return await letter.save();
  }

  async findById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return await Letter.findById(id).lean();
  }

  async findMyLetters(userId) {
    return await Letter.find({ author: userId }).sort({ createdAt: -1 }).lean();
  }

  async findWithPagination(query, page = 1, limit = 20, sort = { createdAt: -1 }) {
    const skip = (page - 1) * limit;
    
    const [letters, total] = await Promise.all([
      Letter.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Letter.countDocuments(query)
    ]);
    
    return {
      letters,
      page,
      totalPages: Math.ceil(total / limit),
      total
    };
  }

  async incrementStat(id, field, amount = 1) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return await Letter.findByIdAndUpdate(
      id,
      { $inc: { [field]: amount } },
      { new: true }
    ).lean();
  }

  async updateStatus(id, status, moderationReason = null) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const updateData = { status };
    if (moderationReason !== null) {
      updateData.moderationReason = moderationReason;
      updateData.isModerated = true;
    }
    
    return await Letter.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true }
    ).lean();
  }
  
  async getDailyStats(startOfDay, endOfDay) {
    return await Letter.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: null,
          totalCreated: { $sum: 1 },
          totalReplies: { $sum: '$replyCount' },
          totalReports: { $sum: '$reportsCount' },
          highPriorityReports: {
            $sum: {
              $cond: [{ $eq: ['$moderationPriority', 'high'] }, 1, 0]
            }
          },
          avgEngagement: { $avg: '$engagementScore' }
        }
      }
    ]);
  }
  
  async getTopCategories(startOfDay, endOfDay) {
    return await Letter.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfDay, $lte: endOfDay },
          status: 'active'
        }
      },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
  }
  
  async getTopFeelings(startOfDay, endOfDay) {
    return await Letter.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfDay, $lte: endOfDay },
          status: 'active',
          feeling: { $ne: null }
        }
      },
      {
        $group: {
          _id: '$feeling',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
  }

  async getTopLanguages(startOfDay, endOfDay) {
    return await Letter.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfDay, $lte: endOfDay },
          status: 'active',
          language: { $ne: null }
        }
      },
      {
        $group: {
          _id: '$language',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
  }

  async countUserLettersToday(userId, startOfDay) {
    return await Letter.countDocuments({
      author: userId,
      createdAt: { $gte: startOfDay }
    });
  }

  async getLatestUserLetter(userId) {
    return await Letter.findOne({ author: userId }).sort({ createdAt: -1 }).lean();
  }
}

module.exports = new LettersRepository();
