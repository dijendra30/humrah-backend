const LaunchRegion = require('../models/LaunchRegion');
const RegionDemand = require('../models/RegionDemand');

class RegionMatcher {
  async getRegionSupport(state, area) {
    if (!state || !area) {
      return { supported: false, status: 'Disabled', regionData: null };
    }

    const region = await LaunchRegion.findOne({
      state: { $regex: new RegExp(`^${state}$`, 'i') },
      area: { $regex: new RegExp(`^${area}$`, 'i') },
      active: true
    });

    if (region) {
      const isSupported = (region.status === 'Supported' || region.status === 'Beta');
      return {
        supported: isSupported,
        status: region.status,
        regionData: region
      };
    }

    return { supported: false, status: 'Disabled', regionData: null };
  }

  async recordDemand(state, area) {
    if (!state || !area) return;

    try {
      const stateClean = state.trim();
      const areaClean = area.trim();

      const existingDemand = await RegionDemand.findOne({
        state: { $regex: new RegExp(`^${stateClean}$`, 'i') },
        area: { $regex: new RegExp(`^${areaClean}$`, 'i') }
      });

      if (existingDemand) {
        existingDemand.totalUsers += 1;
        existingDemand.lastRequestedAt = new Date();
        await existingDemand.save();
      } else {
        await RegionDemand.create({
          state: stateClean,
          area: areaClean,
          totalUsers: 1,
          firstRequestedAt: new Date(),
          lastRequestedAt: new Date()
        });
      }
    } catch (error) {
      console.error('Error recording region demand:', error);
    }
  }
}

module.exports = new RegionMatcher();
