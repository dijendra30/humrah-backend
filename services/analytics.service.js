const LetterAnalytics = require('../models/LetterAnalytics');
const lettersRepo = require('../repositories/letters.repository');

class AnalyticsService {
  async generateDailyAnalytics(dateString = null) {
    const targetDate = dateString ? new Date(dateString) : new Date();
    
    // Set to start of day and end of day in UTC
    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    
    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);
    
    const dateKey = startOfDay.toISOString().split('T')[0];
    
    // Aggregate stats
    const dailyStats = await lettersRepo.getDailyStats(startOfDay, endOfDay);
    const topCategories = await lettersRepo.getTopCategories(startOfDay, endOfDay);
    const topFeelings = await lettersRepo.getTopFeelings(startOfDay, endOfDay);
    const topLanguages = await lettersRepo.getTopLanguages(startOfDay, endOfDay);
    
    let totalCreated = 0;
    let totalReplies = 0;
    let totalReports = 0;
    let highPriorityReports = 0;
    let engagementAverage = 0;
    
    if (dailyStats && dailyStats.length > 0) {
      totalCreated = dailyStats[0].totalCreated || 0;
      totalReplies = dailyStats[0].totalReplies || 0;
      totalReports = dailyStats[0].totalReports || 0;
      highPriorityReports = dailyStats[0].highPriorityReports || 0;
      engagementAverage = dailyStats[0].avgEngagement || 0;
    }
    
    // Assuming activeReaders could be fetched from views, but simplified for now
    const activeReaders = 0; // Requires a LetterView collection to accurately calculate, using 0 as placeholder since LetterView was removed as per user instruction.
    
    const updateData = {
      lettersCreated: totalCreated,
      lettersDeleted: 0, // Simplification for now, we could check removed status
      reportsCount: totalReports,
      repliesCount: totalReplies,
      activeReaders,
      topCategories: topCategories.map(c => ({ category: c._id, count: c.count })),
      topFeelings: topFeelings.map(f => ({ feeling: f._id, count: f.count })),
      topLanguages: topLanguages.map(l => ({ language: l._id, count: l.count })),
      highPriorityReports,
      engagementAverage
    };
    
    await LetterAnalytics.findOneAndUpdate(
      { date: dateKey },
      { $set: updateData },
      { upsert: true, new: true }
    );
    
    return updateData;
  }
}

module.exports = new AnalyticsService();
