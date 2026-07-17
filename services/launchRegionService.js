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

    console.log('\n===== Launch Region Decision =====');
    console.log(`User State: ${targetState}`);
    console.log(`User City/Area: ${targetArea}`);
    console.log(`Matched Region: ${regionData ? regionData.regionName : 'None'}`);
    console.log(`Launch Mode: ${regionData ? regionData.launchMode : 'N/A'}`);
    console.log(`Supported: ${supported}`);
    console.log(`popupRequired: ${popupData ? popupData.required : false}`);
    console.log(`Reason (Type): ${popupData ? popupData.type : 'N/A'}`);
    console.log('==============================\n');

    return {
      supported,
      regionStatus: status,
      userType: user.launchPopupCompleted ? 'EXISTING' : 'NEW',
      popup: popupData
    };
  }

  async completeLaunchPopup(userId, payload) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    user.launchPopupCompleted = true;
    user.launchPopupCompletedAt = new Date();
    
    if (payload.unsupportedRegionAccepted !== undefined) {
      user.unsupportedRegionAccepted = payload.unsupportedRegionAccepted;
    }
    
    if (payload.popupVersionSeen !== undefined) {
      user.popupVersionSeen = payload.popupVersionSeen;
    }
    
    await user.save();
    return user;
  }
}

module.exports = new LaunchRegionService();
