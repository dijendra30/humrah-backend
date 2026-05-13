// routes/companions.js - UPDATED Companion Routes
const express = require('express');
const router  = express.Router();
const { auth, authenticate } = require('../middleware/auth');
const User   = require('../models/User');
const admin  = require('firebase-admin');

// ─── Haversine distance in km ─────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL / 2) ** 2 +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Compatibility score 0-100 ────────────────────────────────────────────────
function calcCompatibilityScore(me, other) {
  const myMood   = me.dailyMood;
  const theirMood = other.dailyMood;

  // 1. Mood overlap (40 pts)
  const myMoods    = myMood.moods    || [];
  const theirMoods = theirMood.moods || [];
  const moodShared = myMoods.filter(m => theirMoods.includes(m)).length;
  const moodMax    = Math.max(myMoods.length, theirMoods.length) || 1;
  const moodMatch  = (moodShared / moodMax) * 40;

  // 2. Energy similarity (25 pts)
  const energyDiff = Math.abs((myMood.energyLevel || 5) - (theirMood.energyLevel || 5));
  const energyMatch = Math.max(0, 1 - energyDiff / 9) * 25;

  // 3. openTo overlap (20 pts)
  const myOpenTo    = myMood.openTo    || [];
  const theirOpenTo = theirMood.openTo || [];
  const openShared  = myOpenTo.filter(a => theirOpenTo.includes(a)).length;
  const openMax     = Math.max(myOpenTo.length, theirOpenTo.length) || 1;
  const openToMatch = (openShared / openMax) * 20;

  // 4. Shared questionnaire interests (10 pts)
  const myInterests    = (me.questionnaire?.interests    || me.questionnaire?.hangoutPreferences || []);
  const theirInterests = (other.questionnaire?.interests || other.questionnaire?.hangoutPreferences || []);
  const intShared  = myInterests.filter(i => theirInterests.includes(i)).length;
  const intMax     = Math.max(myInterests.length, theirInterests.length) || 1;
  const sharedInterest = (intShared / intMax) * 10;

  // 5. Distance bonus (5 pts) — closer = more
  const distKm      = haversineKm(
    me.last_known_lat, me.last_known_lng,
    other.last_known_lat, other.last_known_lng
  );
  const distanceBonus = Math.max(0, (1 - distKm / 5)) * 5;

  return Math.round(moodMatch + energyMatch + openToMatch + sharedInterest + distanceBonus);
}

// @route   GET /api/companions
// @desc    Get list of companions (only users with userType='COMPANION')
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const { interests, city, state, limit = 20 } = req.query;
    
    // ✅ CRITICAL FIX: Only show COMPANION users
    const filter = { 
      _id: { $ne: req.userId },
      userType: 'COMPANION',      // ✅ Only companions
      status: 'ACTIVE'             // Only active users
    };

    if (interests) {
      const interestArray = interests.split(',');
      filter['questionnaire.interests'] = { $in: interestArray };
    }

    if (city) filter['questionnaire.city'] = city;
    if (state) filter['questionnaire.state'] = state;

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(parseInt(limit))
      .sort({ 
        isPremium: -1,                    // Premium first
        'ratingStats.averageRating': -1,  // Then by rating
        lastActive: -1                     // Then by activity
      });

    res.json({
      success: true,
      companions
    });

  } catch (error) {
    console.error('Get companions error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/companions/recommended
// @desc    Get recommended companions (only userType='COMPANION')
// @access  Private
router.get('/recommended', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId);
    
    if (!currentUser || !currentUser.questionnaire) {
      return res.status(400).json({ 
        success: false, 
        message: 'Complete your profile first' 
      });
    }

    // ✅ CRITICAL FIX: Only show COMPANION users
    const filter = { 
      _id: { $ne: req.userId },
      userType: 'COMPANION',  // ✅ Only companions
      status: 'ACTIVE'
    };

    // Match by location
    if (currentUser.questionnaire.city) {
      filter['questionnaire.city'] = currentUser.questionnaire.city;
    }

    // Match by interests
    if (currentUser.questionnaire.interests?.length > 0) {
      filter['questionnaire.interests'] = { 
        $in: currentUser.questionnaire.interests 
      };
    }

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(10)
      .sort({ 
        'ratingStats.averageRating': -1,
        lastActive: -1 
      });

    res.json({
      success: true,
      companions
    });

  } catch (error) {
    console.error('Get recommended companions error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/companions/:companionId
// @desc    Get companion profile details
// @access  Private
router.get('/:companionId', auth, async (req, res) => {
  try {
    const companion = await User.findOne({
      _id: req.params.companionId,
      userType: 'COMPANION',  // ✅ Must be companion
      status: 'ACTIVE'
    }).select('-password -emailVerificationOTP -fcmTokens');

    if (!companion) {
      return res.status(404).json({
        success: false,
        message: 'Companion not found'
      });
    }

    res.json({
      success: true,
      companion: companion.getPublicProfile()
    });

  } catch (error) {
    console.error('Get companion error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/companions/mood-matches
// @desc    Get nearby users with compatible daily mood
// @access  Private
router.get('/mood-matches', authenticate, async (req, res) => {
  try {
    const now = new Date();

    // Get current user with location + mood + questionnaire
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng last_location_updated_at dailyMood questionnaire blockedUsers status')
      .lean();

    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    // Must have active mood
    if (!me.dailyMood || !me.dailyMood.expiresAt || new Date(me.dailyMood.expiresAt) <= now) {
      return res.json({ success: true, users: [], message: 'Set your mood first to find matches' });
    }

    // Must have recent location (within 24h)
    const locationAge = me.last_location_updated_at
      ? (now - new Date(me.last_location_updated_at)) / (1000 * 60 * 60)
      : 999;
    if (locationAge > 24 || me.last_known_lat == null) {
      return res.json({ success: true, users: [], message: 'Share your location to find mood matches' });
    }

    const blockedIds = (me.blockedUsers || []).map(id => id.toString());

    // Fetch candidates: active mood, visible, recently active, not blocked
    const candidates = await User.find({
      _id:    { $ne: req.userId, $nin: blockedIds },
      status: 'ACTIVE',
      last_location_updated_at: { $gte: new Date(now - 24 * 60 * 60 * 1000) },
      last_known_lat: { $ne: null },
      last_known_lng: { $ne: null },
      'dailyMood.expiresAt': { $gt: now },
      'dailyMood.visible':   true
    })
    .select('firstName age profilePhoto verified last_known_lat last_known_lng dailyMood questionnaire')
    .lean();

    // Filter by 5km radius + compute score
    const MAX_KM = 5;
    const results = [];

    for (const candidate of candidates) {
      const distKm = haversineKm(
        me.last_known_lat, me.last_known_lng,
        candidate.last_known_lat, candidate.last_known_lng
      );
      if (distKm > MAX_KM) continue;

      const score = calcCompatibilityScore(me, candidate);

      results.push({
        _id:               candidate._id,
        firstName:         candidate.firstName,
        age:               candidate.age || null,
        profilePhoto:      candidate.profilePhoto,
        verified:          candidate.verified,
        distanceKm:        Math.round(distKm * 10) / 10,
        compatibilityScore: score,
        dailyMood: {
          moods:       candidate.dailyMood.moods,
          energyLevel: candidate.dailyMood.energyLevel,
          openTo:      candidate.dailyMood.openTo
        }
      });
    }

    // Sort by score desc, limit 10
    results.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
    const top10 = results.slice(0, 10);

    res.json({ success: true, users: top10 });

  } catch (error) {
    console.error('Mood matches error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/companions/mood-request
// @desc    Send a mood-based connection request
// @access  Private
router.post('/mood-request', authenticate, async (req, res) => {
  try {
    const { receiverId, message } = req.body;

    if (!receiverId) {
      return res.status(400).json({ success: false, message: 'receiverId is required' });
    }

    const now = new Date();

    const [me, receiver] = await Promise.all([
      User.findById(req.userId)
        .select('last_known_lat last_known_lng dailyMood blockedUsers firstName')
        .lean(),
      User.findById(receiverId)
        .select('last_known_lat last_known_lng dailyMood blockedUsers fcmTokens firstName')
        .lean()
    ]);

    if (!receiver) return res.status(404).json({ success: false, message: 'User not found' });

    // Both moods must be active
    const myMoodActive  = me.dailyMood?.expiresAt && new Date(me.dailyMood.expiresAt) > now;
    const recMoodActive = receiver.dailyMood?.expiresAt && new Date(receiver.dailyMood.expiresAt) > now;
    if (!myMoodActive || !recMoodActive) {
      return res.status(400).json({ success: false, message: 'Both users must have an active mood' });
    }

    // Within 5km
    if (me.last_known_lat == null || receiver.last_known_lat == null) {
      return res.status(400).json({ success: false, message: 'Location required for mood requests' });
    }
    const distKm = haversineKm(
      me.last_known_lat, me.last_known_lng,
      receiver.last_known_lat, receiver.last_known_lng
    );
    if (distKm > 5) {
      return res.status(400).json({ success: false, message: 'User is not within 5km' });
    }

    // Not blocked
    const blockedByReceiver = (receiver.blockedUsers || []).map(id => id.toString());
    if (blockedByReceiver.includes(req.userId.toString())) {
      return res.status(403).json({ success: false, message: 'Unable to send request' });
    }

    // Build notification message
    const notifMsg = message ||
      `${me.firstName} wants to connect — you both share similar vibes today ☕`;

    // Send FCM push notification
    if (receiver.fcmTokens && receiver.fcmTokens.length > 0) {
      try {
        await admin.messaging().sendEachForMulticast({
          tokens: receiver.fcmTokens,
          notification: {
            title: `${me.firstName} wants to connect ✨`,
            body:  notifMsg
          },
          data: {
            type:       'mood_request',
            senderId:   req.userId.toString(),
            senderName: me.firstName
          },
          android: { priority: 'normal' }
        });
      } catch (fcmErr) {
        console.error('Mood request FCM error (non-fatal):', fcmErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Mood request sent!',
      notificationSent: (receiver.fcmTokens?.length || 0) > 0
    });

  } catch (error) {
    console.error('Mood request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
