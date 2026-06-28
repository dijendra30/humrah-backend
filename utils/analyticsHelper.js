const analyticsService = require('../services/analytics.service');

const runDailyAnalytics = async () => {
  try {
    console.log('[Humrah Letters] Running daily analytics job...');
    await analyticsService.generateDailyAnalytics();
    console.log('[Humrah Letters] Daily analytics generated successfully.');
  } catch (error) {
    console.error('[Humrah Letters] Failed to run daily analytics:', error);
  }
};

module.exports = {
  runDailyAnalytics
};
