// routes/companions.js
const express = require('express');
const router  = express.Router();
const { auth, authenticate } = require('../middleware/auth');
const User   = require('../models/User');
const admin  = require('firebase-admin');

// ─── Allowed mood + openTo values (FIX #10: allowlist) ───────────────────────
const VALID_MOODS = new Set([
  'Cafe Mood','Food Mood','Walk Mood','Talk Mood','Study Mood',
  'Explore Mood','Chill Mood','Photo Mood','Shop Mood',
  'Night Mood','Fitness Mood'
]); // Drive Mood removed (safety concern)
const VALID_OPEN_TO = new Set([
  'Cafe','Coffee','Food','Walk','Talk','Study','Explore',
  'Chill','Drive','Photos','Shopping','Night Out','Fitness'
]);

// ─── Night-mode helpers (FIX #5, #6, #15) ────────────────────────────────────
function getRadiusKm() {
  const hour = new Date().getHours();
  return (hour >= 21 || hour < 6) ? 2 : 5;
}
function isNightTime() {
  const hour = new Date().getHours();
  return hour >= 21 || hour < 6;
}

// ─── Haversine ───────────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL / 2) ** 2 +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Compatibility score 0-100 (FIX #15: dynamic radius denominator) ─────────
function calcCompatibilityScore(me, other, maxKm) {
  const myMood    = me.dailyMood;
  const theirMood = other.dailyMood;

  const myMoods    = myMood.moods    || [];
  const theirMoods = theirMood.moods || [];
  const moodMatch  = (myMoods.filter(m => theirMoods.includes(m)).length /
                      (Math.max(myMoods.length, theirMoods.length) || 1)) * 40;

  const energyDiff  = Math.abs((myMood.energyLevel || 5) - (theirMood.energyLevel || 5));
  const energyMatch = Math.max(0, 1 - energyDiff / 9) * 25;

  const myOpenTo    = myMood.openTo    || [];
  const theirOpenTo = theirMood.openTo || [];
  const openToMatch = (myOpenTo.filter(a => theirOpenTo.includes(a)).length /
                       (Math.max(myOpenTo.length, theirOpenTo.length) || 1)) * 20;

  const myInterests    = (me.questionnaire?.interests    || me.questionnaire?.hangoutPreferences || []);
  const theirInterests = (other.questionnaire?.interests || other.questionnaire?.hangoutPreferences || []);
  const sharedInterest = (myInterests.filter(i => theirInterests.includes(i)).length /
                          (Math.max(myInterests.length, theirInterests.length) || 1)) * 10;

  const distKm        = haversineKm(me.last_known_lat, me.last_known_lng, other.last_known_lat, other.last_known_lng);
  const distanceBonus = Math.max(0, (1 - distKm / maxKm)) * 5;

  return Math.round(moodMatch + energyMatch + openToMatch + sharedInterest + distanceBonus);
}

// =============================================================
// FIX #1: mood routes BEFORE /:companionId wildcard
// =============================================================

// GET /api/companions/mood-matches
router.get('/mood-matches', authenticate, async (req, res) => {
  try {
    const now    = new Date();
    const MAX_KM = getRadiusKm(); // FIX #5
    const night  = isNightTime();

    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng last_location_updated_at dailyMood questionnaire blockedUsers status')
      .lean();
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    // FIX #18: return noMoodSet flag so frontend can distinguish
    if (!me.dailyMood?.expiresAt || new Date(me.dailyMood.expiresAt) <= now) {
      return res.json({ success: true, users: [], noMoodSet: true, message: 'Set your mood first to find matches' });
    }

    const locationAge = me.last_location_updated_at
      ? (now - new Date(me.last_location_updated_at)) / (1000 * 60 * 60) : 999;
    if (locationAge > 24 || me.last_known_lat == null) {
      return res.json({ success: true, users: [], noMoodSet: false, message: 'Share your location to find mood matches' });
    }

    const blockedIds = (me.blockedUsers || []).map(id => id.toString());

    // FIX #13: bounding box pre-filter before JS haversine loop
    const deltaLat = MAX_KM / 111.0;
    const deltaLng = MAX_KM / (111.0 * Math.cos(me.last_known_lat * Math.PI / 180));

    const candidates = await User.find({
      _id:    { $ne: req.userId, $nin: blockedIds },
      status: 'ACTIVE',
      last_location_updated_at: { $gte: new Date(now - 24 * 60 * 60 * 1000) },
      last_known_lat: { $gte: me.last_known_lat - deltaLat, $lte: me.last_known_lat + deltaLat },
      last_known_lng: { $gte: me.last_known_lng - deltaLng, $lte: me.last_known_lng + deltaLng },
      'dailyMood.expiresAt': { $gt: now },
      'dailyMood.visible':   true
    })
    .select('firstName age profilePhoto verified last_known_lat last_known_lng dailyMood questionnaire')
    .lean();

    const results = [];
    for (const c of candidates) {
      // FIX #17: null coordinate guard on candidate
      if (c.last_known_lat == null || c.last_known_lng == null) continue;

      const distKm = haversineKm(me.last_known_lat, me.last_known_lng, c.last_known_lat, c.last_known_lng);
      if (distKm > MAX_KM) continue;

      results.push({
        _id:                c._id,
        firstName:          c.firstName,
        age:                c.age || null,
        profilePhoto:       c.profilePhoto,
        verified:           c.verified,
        distanceKm:         Math.round(distKm * 10) / 10,
        compatibilityScore: calcCompatibilityScore(me, c, MAX_KM), // FIX #15
        dailyMood: { moods: c.dailyMood.moods, energyLevel: c.dailyMood.energyLevel, openTo: c.dailyMood.openTo }
      });
    }

    // FIX #5: night → verified-first sort
    results.sort(night
      ? (a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || b.compatibilityScore - a.compatibilityScore
      : (a, b) => b.compatibilityScore - a.compatibilityScore
    );

    res.json({ success: true, users: results.slice(0, 10), noMoodSet: false, expiresAt: me.dailyMood.expiresAt });

  } catch (error) {
    console.error('Mood matches error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/companions/mood-request
router.post('/mood-request', authenticate, async (req, res) => {
  try {
    const { receiverId, message } = req.body;
    if (!receiverId) return res.status(400).json({ success: false, message: 'receiverId is required' });

    // FIX #11: cap message length
    if (message && message.length > 200) {
      return res.status(400).json({ success: false, message: 'Message must be under 200 characters' });
    }

    const now    = new Date();
    const MAX_KM = getRadiusKm(); // FIX #6: night-aware radius

    const [me, receiver] = await Promise.all([
      User.findById(req.userId).select('last_known_lat last_known_lng dailyMood blockedUsers firstName moodRequestsSent').lean(),
      User.findById(receiverId).select('last_known_lat last_known_lng dailyMood blockedUsers fcmTokens firstName').lean()
    ]);

    if (!receiver) return res.status(404).json({ success: false, message: 'User not found' });

    if (!me.dailyMood?.expiresAt || new Date(me.dailyMood.expiresAt) <= now ||
        !receiver.dailyMood?.expiresAt || new Date(receiver.dailyMood.expiresAt) <= now) {
      return res.status(400).json({ success: false, message: 'Both users must have an active mood' });
    }

    // FIX #17: null location guard
    if (me.last_known_lat == null || receiver.last_known_lat == null) {
      return res.status(400).json({ success: false, message: 'Location required for mood requests' });
    }

    // FIX #6: night-aware radius
    const distKm = haversineKm(me.last_known_lat, me.last_known_lng, receiver.last_known_lat, receiver.last_known_lng);
    if (distKm > MAX_KM) {
      return res.status(400).json({ success: false, message: `User is not within ${MAX_KM}km` });
    }

    // FIX #3: bidirectional block check
    const blockedByReceiver = (receiver.blockedUsers || []).map(id => id.toString());
    const blockedByMe       = (me.blockedUsers       || []).map(id => id.toString());
    if (blockedByReceiver.includes(req.userId.toString()) || blockedByMe.includes(receiverId.toString())) {
      return res.status(403).json({ success: false, message: 'Unable to send request' });
    }

    // FIX #4: 1-hour duplicate throttle per (sender, receiver) pair
    const lastSentAt  = me.moodRequestsSent?.[receiverId];
    const COOLDOWN_MS = 60 * 60 * 1000;
    if (lastSentAt && (now - new Date(lastSentAt)) < COOLDOWN_MS) {
      const waitMins = Math.ceil((COOLDOWN_MS - (now - new Date(lastSentAt))) / 60000);
      return res.status(429).json({ success: false, message: `Wait ${waitMins} min before requesting again` });
    }
    User.findByIdAndUpdate(req.userId, { $set: { [`moodRequestsSent.${receiverId}`]: now } }).exec();

    const notifMsg = (message?.trim()) || `${me.firstName} wants to connect — you both share similar vibes today ☕`;

    if (receiver.fcmTokens?.length > 0) {
      try {
        await admin.messaging().sendEachForMulticast({
          tokens: receiver.fcmTokens,
          notification: { title: `${me.firstName} wants to connect ✨`, body: notifMsg },
          data: { type: 'mood_request', senderId: req.userId.toString(), senderName: me.firstName },
          android: { priority: 'normal' }
        });
      } catch (fcmErr) { console.error('Mood request FCM error (non-fatal):', fcmErr.message); }
    }

    res.json({ success: true, message: 'Mood request sent!', notificationSent: (receiver.fcmTokens?.length || 0) > 0 });

  } catch (error) {
    console.error('Mood request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================================
// Companion routes — wildcard /:companionId BELOW mood routes
// =============================================================

// GET /api/companions
router.get('/', auth, async (req, res) => {
  try {
    const { interests, city, state, limit = 20 } = req.query;
    const filter = { _id: { $ne: req.userId }, userType: 'COMPANION', status: 'ACTIVE' };
    if (interests) filter['questionnaire.interests'] = { $in: interests.split(',') };
    if (city)      filter['questionnaire.city']      = city;
    if (state)     filter['questionnaire.state']     = state;

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(parseInt(limit))
      .sort({ isPremium: -1, 'ratingStats.averageRating': -1, lastActive: -1 });

    res.json({ success: true, companions });
  } catch (error) {
    console.error('Get companions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/companions/recommended
router.get('/recommended', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId);
    if (!currentUser?.questionnaire) {
      return res.status(400).json({ success: false, message: 'Complete your profile first' });
    }

    const filter = { _id: { $ne: req.userId }, userType: 'COMPANION', status: 'ACTIVE' };
    if (currentUser.questionnaire.city)                 filter['questionnaire.city']      = currentUser.questionnaire.city;
    if (currentUser.questionnaire.interests?.length > 0) filter['questionnaire.interests'] = { $in: currentUser.questionnaire.interests };

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(10)
      .sort({ 'ratingStats.averageRating': -1, lastActive: -1 });

    res.json({ success: true, companions });
  } catch (error) {
    console.error('Get recommended companions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/companions/:companionId — wildcard LAST
router.get('/:companionId', auth, async (req, res) => {
  try {
    const companion = await User.findOne({
      _id: req.params.companionId, userType: 'COMPANION', status: 'ACTIVE'
    }).select('-password -emailVerificationOTP -fcmTokens');

    if (!companion) return res.status(404).json({ success: false, message: 'Companion not found' });

    res.json({ success: true, companion: companion.getPublicProfile() });
  } catch (error) {
    console.error('Get companion error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
