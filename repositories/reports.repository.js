const LetterReport = require('../models/LetterReport');
const mongoose = require('mongoose');

class ReportsRepository {
  async create(data) {
    try {
      const report = new LetterReport(data);
      return await report.save();
    } catch (error) {
      if (error.code === 11000) {
        const dupError = new Error('DuplicateReport');
        dupError.code = 11000;
        throw dupError;
      }
      throw error;
    }
  }

  async countUserReportsToday(userId, startOfDay) {
    return await LetterReport.countDocuments({
      reportedBy: userId,
      createdAt: { $gte: startOfDay }
    });
  }
}

module.exports = new ReportsRepository();
