const User = require('../models/User');
const regionMatcher = require('./regionMatcher');
const popupService = require('./popupService');

class LaunchRegionService {
  async getUserRegionStatus(userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    let targetState = user.homeRegion?.state || user.state;
    let targetArea = user.homeRegion?.area || user.area;

    const matchResult = await regionMatcher.getRegionSupport(targetState, targetArea);
    const { supported, status, regionData } = matchResult;

    if (!supported && !user.launchPopupCompleted) {
      await regionMatcher.recordDemand(targetState, targetArea);
    }

    const popupData = popupService.buildPopupResponse(user, regionData, supported);

    return {
      supported,
      regionStatus: status,
      ...popupData
    };
  }
}

module.exports = new LaunchRegionService();
