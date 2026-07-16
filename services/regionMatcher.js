const LaunchRegion = require('../models/LaunchRegion');
const RegionDemand = require('../models/RegionDemand');
const LaunchConfiguration = require('../models/LaunchConfiguration');

const isDev = process.env.NODE_ENV !== 'production';

class RegionMatcher {
  async getRegionSupport(state, area) {
    if (!state || !area) {
      return { supported: false, status: 'DISABLED', regionData: null };
    }

    // 1. Fetch Configuration (Default to WHITELIST if missing)
    let config = await LaunchConfiguration.findOne();
    const mode = config ? config.mode : 'WHITELIST';
    
    if (isDev) console.log(`\n[DEV] regionMatcher -> Checking State: ${state}, Area: ${area} | Mode: ${mode}`);

    // 2. ALL_INDIA Mode overrides everything immediately
    if (mode === 'ALL_INDIA') {
      if (isDev) console.log(`[DEV] regionMatcher -> ALL_INDIA Mode active. Supported: true`);
      return { supported: true, status: 'SUPPORTED', regionData: null };
    }

    // 3. Lookup region in DB
    const region = await LaunchRegion.findOne({
      state: { $regex: new RegExp(`^${state}$`, 'i') },
      area: { $regex: new RegExp(`^${area}$`, 'i') },
      active: true
    });

    if (isDev) console.log(`[DEV] regionMatcher -> DB Match Found: ${!!region}`);

    // 4. WHITELIST Mode
    if (mode === 'WHITELIST') {
      if (region) {
        const isSupported = (region.status === 'SUPPORTED' || region.status === 'LIMITED');
        return {
          supported: isSupported,
          status: region.status,
          regionData: region
        };
      }
      return { supported: false, status: 'DISABLED', regionData: null };
    }

    // 5. BLACKLIST Mode
    if (mode === 'BLACKLIST') {
      // If it IS in the DB, respect the DB's status (it might be DISABLED or LIMITED)
      if (region) {
        const isSupported = (region.status === 'SUPPORTED' || region.status === 'LIMITED');
        return {
          supported: isSupported,
          status: region.status,
          regionData: region
        };
      }
      // If it is NOT in the DB, it is immediately supported
      return { supported: true, status: 'SUPPORTED', regionData: null };
    }

    // Fallback safety
    return { supported: false, status: 'DISABLED', regionData: null };
  }

  async recordDemand(state, area, userId = null) {
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
        if (userId) existingDemand.lastUserId = userId;
        await existingDemand.save();
      } else {
        await RegionDemand.create({
          state: stateClean,
          area: areaClean,
          totalUsers: 1,
          firstRequestedAt: new Date(),
          lastRequestedAt: new Date(),
          lastUserId: userId
        });
      }
    } catch (error) {
      console.error('Error recording region demand:', error);
    }
  }
}

module.exports = new RegionMatcher();
