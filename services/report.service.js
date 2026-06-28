const reportsRepo = require('../repositories/reports.repository');
const lettersRepo = require('../repositories/letters.repository');

class ReportService {
  async reportLetter(userId, letterId, reason, customReason = null) {
    // Save report
    const reportData = {
      letterId,
      reportedBy: userId,
      reason,
      customReason
    };
    
    await reportsRepo.create(reportData);
    
    // Update letter reportsCount
    const letter = await lettersRepo.incrementStat(letterId, 'reportsCount', 1);
    
    if (!letter) return null;

    // Check threshold for auto-moderation
    if (letter.reportsCount >= 10) {
      // 10 reports -> removed
      await lettersRepo.updateStatus(letterId, 'removed', 'Auto-removed due to excessive reports (>=10)');
    } else if (letter.reportsCount >= 5 && letter.status === 'active') {
      // 5 reports -> under review
      await lettersRepo.updateStatus(letterId, 'under_review', 'Auto-flagged for review due to multiple reports (>=5)');
    }
    
    return true;
  }
}

module.exports = new ReportService();
