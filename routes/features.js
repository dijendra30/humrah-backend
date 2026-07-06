const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const FeatureInterestUser = require('../models/FeatureInterestUser');
const FeatureInterestStats = require('../models/FeatureInterestStats');

// Helper to normalize city names (e.g. " delhi " -> "Delhi")
function normalizeCity(cityStr) {
  if (!cityStr) return 'Unknown';
  const trimmed = cityStr.trim();
  if (trimmed.length === 0) return 'Unknown';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

// POST /api/features/interest
router.post('/interest', auth, async (req, res) => {
  try {
    let { feature } = req.body;
    
    if (!feature) {
      return res.status(400).json({ success: false, message: 'Feature name is required' });
    }

    // 1. Normalize feature
    feature = feature.trim().toUpperCase();

    // 2. Get user and city
    const user = await User.findById(req.userId).select('liveLocation questionnaire city');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    let rawCity = user.liveLocation?.city || user.questionnaire?.city || user.city || 'Unknown';
    const city = normalizeCity(rawCity);

    // 3. Create FeatureInterestUser with atomic duplicate protection
    try {
      await FeatureInterestUser.create({
        userId: user._id,
        feature,
        city
      });
    } catch (error) {
      // 11000 is MongoDB's duplicate key error code
      if (error.code === 11000) {
        console.log(`[Feature Interest] feature=${feature} duplicate=true`);
        return res.json({
          success: true,
          alreadyRegistered: true,
          message: "Already registered"
        });
      }
      throw error; // Re-throw if it's a different error
    }

    // 4. If we reach here, it's a new interest. Increment city counter.
    await FeatureInterestStats.findOneAndUpdate(
      { feature, city },
      { $inc: { totalInterest: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`[Feature Interest] feature=${feature} city=${city} newInterest=true`);

    return res.json({
      success: true,
      alreadyRegistered: false,
      message: "Interest registered"
    });

  } catch (error) {
    console.error(`[Feature Interest] Error registering interest:`, error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
