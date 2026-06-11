// routes/companions.js
'use strict';

const express          = require('express');
const router           = express.Router();
const { auth, authenticate } = require('../middleware/auth');
const User             = require('../models/User');
const MatchingTodayMood = require('../models/MatchingTodayMood');
const admin            = require('firebase-admin');

// =============================================================================
// HELPERS
// =============================================================================

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dL = (lat2-lat1)*Math.PI/180, dG = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getRadiusKm() { const h = new Date().getHours(); return (h >= 21 || h < 6) ? 2 : 5; }
function isNightTime() { const h = new Date().getHours(); return h >= 21 || h < 6; }

// =============================================================================
// GET /api/companions/mood-places
//
// Returns the cached nearbyData from MatchingTodayMood for this user.
// Nearby fetching happens ONLY in appOpen (matchingMoodController).
// This endpoint is read-only — no Overpass calls here.
// =============================================================================

router.get('/mood-places', authenticate, async (req, res) => {
  try {
    const doc = await MatchingTodayMood.findOne({ userId: req.userId })
      .select('nearbyData locationHash updatedAt')
      .lean();

    if (!doc || !doc.nearbyData) {
      return res.json({ success: true, nearbyData: { count: 0, places: [] }, cached: false });
    }

    return res.json({
      success:      true,
      nearbyData:   doc.nearbyData,
      locationHash: doc.locationHash,
      cached:       true,
    });
  } catch (err) {
    console.error('[mood-places]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================================================
// GET /api/companions/mood-matches
//
// Reads active moods from MatchingTodayMood collection only.
// No DailyMood fallback — that collection is retired.
// =============================================================================

function calcCompatScore(me, other, maxKm) {
  const mm = me._mtm   || {};
  const om = other._mtm || {};

  const myMood  = mm.mood  ? [mm.mood]  : [];
  const othMood = om.mood  ? [om.mood]  : [];
  const myVibe  = _vibeToEnergy(mm.vibeLevel) || 5;
  const othVibe = _vibeToEnergy(om.vibeLevel) || 5;

  const moodM  = (myMood.filter(m => othMood.includes(m)).length / (Math.max(myMood.length, othMood.length) || 1)) * 40;
  const energM = Math.max(0, 1 - Math.abs(myVibe - othVibe) / 9) * 25;

  const myI = me.questionnaire?.interests  || me.questionnaire?.hangoutPreferences || [];
  const thI = other.questionnaire?.interests || other.questionnaire?.hangoutPreferences || [];
  const intM = (myI.filter(i => thI.includes(i)).length / (Math.max(myI.length, thI.length) || 1)) * 30;

  const distKm = haversineKm(me.last_known_lat, me.last_known_lng, other.last_known_lat, other.last_known_lng);
  const distB  = Math.max(0, 1 - distKm / maxKm) * 5;

  return Math.round(moodM + energM + intM + distB);
}

function _vibeToEnergy(vibe) {
  if (!vibe) return null;
  return { lowkey: 3, normal: 6, social: 9 }[vibe.toLowerCase()] || null;
}

router.get('/mood-matches', authenticate, async (req, res) => {
  try {
    const now    = new Date();
    const MAX_KM = getRadiusKm();
    const night  = isNightTime();

    // ── Requesting user ───────────────────────────────────────────────────────
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng last_location_updated_at questionnaire blockedUsers status')
      .lean();
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    // ── My active mood ────────────────────────────────────────────────────────
    const myMTM = await MatchingTodayMood.findOne({
      userId:    req.userId,
      visible:   true,
      expiresAt: { $gt: now },
    }).lean();

    if (!myMTM) {
      return res.json({ success: true, users: [], noMoodSet: true, message: 'Set your mood first' });
    }

    // ── Location check ────────────────────────────────────────────────────────
    const locationAge = me.last_location_updated_at
      ? (now - new Date(me.last_location_updated_at)) / 3600000 : 999;
    if (locationAge > 24 || me.last_known_lat == null) {
      return res.json({ success: true, users: [], noMoodSet: false, message: 'Share your location to find matches' });
    }

    me._mtm = myMTM;

    const blockedIds = (me.blockedUsers || []).map(id => id.toString());
    const dLat = MAX_KM / 111.0;
    const dLng = MAX_KM / (111.0 * Math.cos(me.last_known_lat * Math.PI / 180));

    // ── Active mood docs in this area (capped at 200 to avoid full-collection scan) ──
    const activeMTMs = await MatchingTodayMood.find({
      userId:    { $ne: req.userId },
      visible:   true,
      expiresAt: { $gt: now },
    }).select('userId mood vibeLevel intention').limit(200).lean();

    const activeUserIds = activeMTMs
      .map(d => d.userId.toString())
      .filter(id => !blockedIds.includes(id));

    if (activeUserIds.length === 0) {
      return res.json({ success: true, users: [], noMoodSet: false, expiresAt: myMTM.expiresAt });
    }

    // ── Bounding-box candidate query ──────────────────────────────────────────
    const candidates = await User.find({
      _id:                      { $in: activeUserIds, $nin: blockedIds },
      status:                   'ACTIVE',
      last_location_updated_at: { $gte: new Date(now - 86400000) },
      last_known_lat:           { $gte: me.last_known_lat - dLat, $lte: me.last_known_lat + dLat },
      last_known_lng:           { $gte: me.last_known_lng - dLng, $lte: me.last_known_lng + dLng },
    }).select('firstName profilePhoto verified photoVerificationStatus last_known_lat last_known_lng questionnaire').lean();

    // Attach MTM doc to each candidate
    const mtmByUser = {};
    activeMTMs.forEach(d => { mtmByUser[d.userId.toString()] = d; });
    candidates.forEach(c => { c._mtm = mtmByUser[c._id.toString()] || null; });

    // ── Filter by exact radius + build result ─────────────────────────────────
    const results = [];
    for (const c of candidates) {
      if (c.last_known_lat == null || c.last_known_lng == null || !c._mtm) continue;
      const distKm = haversineKm(me.last_known_lat, me.last_known_lng, c.last_known_lat, c.last_known_lng);
      if (distKm > MAX_KM) continue;

      results.push({
        _id:                     c._id,
        firstName:               c.firstName,
        profilePhoto:            c.profilePhoto,
        verified:                c.verified,
        photoVerificationStatus: c.photoVerificationStatus || null,
        distanceKm:              Math.round(distKm * 10) / 10,
        compatibilityScore:      calcCompatScore(me, c, MAX_KM),
        mood:                    c._mtm.mood,
        vibeLevel:               c._mtm.vibeLevel,
        intention:               c._mtm.intention || null,
      });
    }

    results.sort(night
      ? (a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || b.compatibilityScore - a.compatibilityScore
      : (a, b) => b.compatibilityScore - a.compatibilityScore
    );

    return res.json({
      success:   true,
      users:     results.slice(0, 10),
      noMoodSet: false,
      expiresAt: myMTM.expiresAt,
    });

  } catch (err) {
    console.error('[mood-matches]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================================================
// POST /api/companions/mood-request
// =============================================================================

router.post('/mood-request', authenticate, async (req, res) => {
  try {
    const { receiverId, message } = req.body;
    if (!receiverId) return res.status(400).json({ success: false, message: 'receiverId required' });
    if (message && message.length > 200) return res.status(400).json({ success: false, message: 'Message too long' });

    const now    = new Date();
    const MAX_KM = getRadiusKm();

    const [me, receiver] = await Promise.all([
      User.findById(req.userId).select('last_known_lat last_known_lng blockedUsers firstName moodRequestsSent').lean(),
      User.findById(receiverId).select('last_known_lat last_known_lng blockedUsers fcmTokens firstName').lean(),
    ]);

    if (!receiver) return res.status(404).json({ success: false, message: 'User not found' });

    const [myMTM, recMTM] = await Promise.all([
      MatchingTodayMood.findOne({ userId: req.userId,  visible: true, expiresAt: { $gt: now } }).lean(),
      MatchingTodayMood.findOne({ userId: receiverId,  visible: true, expiresAt: { $gt: now } }).lean(),
    ]);

    if (!myMTM || !recMTM) {
      return res.status(400).json({ success: false, message: 'Both users must have an active mood' });
    }

    if (me.last_known_lat == null || receiver.last_known_lat == null) {
      return res.status(400).json({ success: false, message: 'Location required' });
    }

    const distKm = haversineKm(me.last_known_lat, me.last_known_lng, receiver.last_known_lat, receiver.last_known_lng);
    if (distKm > MAX_KM) return res.status(400).json({ success: false, message: `User not within ${MAX_KM}km` });

    const blockedByRec = (receiver.blockedUsers || []).map(id => id.toString());
    const blockedByMe  = (me.blockedUsers || []).map(id => id.toString());
    if (blockedByRec.includes(req.userId.toString()) || blockedByMe.includes(receiverId.toString())) {
      return res.status(403).json({ success: false, message: 'Unable to send request' });
    }

    const lastSent = me.moodRequestsSent?.[receiverId];
    const COOL = 3600000;
    if (lastSent && (now - new Date(lastSent)) < COOL) {
      const wait = Math.ceil((COOL - (now - new Date(lastSent))) / 60000);
      return res.status(429).json({ success: false, message: `Wait ${wait} min before requesting again` });
    }
    User.findByIdAndUpdate(req.userId, { $set: { [`moodRequestsSent.${receiverId}`]: now } }).exec();

    const notifMsg = message?.trim() || `${me.firstName} wants to connect — you both share similar vibes today ☕`;
    if (receiver.fcmTokens?.length > 0) {
      try {
        await admin.messaging().sendEachForMulticast({
          tokens:       receiver.fcmTokens,
          notification: { title: `${me.firstName} wants to connect ✨`, body: notifMsg },
          data:         { type: 'mood_request', senderId: req.userId.toString(), senderName: me.firstName },
          android:      { priority: 'normal' },
        });
      } catch (e) { console.error('[mood-request] FCM (non-fatal):', e.message); }
    }

    return res.json({ success: true, message: 'Mood request sent!', notificationSent: (receiver.fcmTokens?.length || 0) > 0 });

  } catch (err) {
    console.error('[mood-request]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================================================
// COMPANION LIST ROUTES (wildcard /:companionId must be LAST)
// =============================================================================

router.get('/recommended', auth, async (req, res) => {
  try {
    const STALE_MS = 60 * 60 * 1000; // 60 min
    const u = await User.findById(req.userId).select('liveLocation questionnaire');
    if (!u) return res.status(404).json({ success: false, message: 'User not found' });

    // Prefer liveLocation for city; fall back to questionnaire.city
    const ll = u.liveLocation;
    const hasLiveLocation = !!(ll && ll.lat != null && ll.lng != null &&
      ll.updatedAt && (Date.now() - new Date(ll.updatedAt).getTime()) <= STALE_MS);
    const searchCity = (hasLiveLocation && ll.city) ? ll.city : u.questionnaire?.city;

    const f = { _id: { $ne: req.userId }, userType: 'COMPANION', status: 'ACTIVE' };
    // Match by liveLocation.city first; fall back to questionnaire.city
    if (searchCity) {
      f.$or = [
        { 'liveLocation.city': searchCity },
        { 'questionnaire.city': searchCity },
      ];
    }
    if (u.questionnaire?.interests?.length) f['questionnaire.interests'] = { $in: u.questionnaire.interests };
    const companions = await User.find(f)
      .select('firstName lastName profilePhoto questionnaire liveLocation ratingStats verified isPremium userType')
      .limit(10).sort({ 'ratingStats.averageRating': -1, lastActive: -1 });
    res.json({ success: true, companions });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/', auth, async (req, res) => {
  try {
    const { interests, city, state, limit = 20 } = req.query;
    const f = { _id: { $ne: req.userId }, userType: 'COMPANION', status: 'ACTIVE' };
    if (interests) f['questionnaire.interests'] = { $in: interests.split(',') };
    // city filter: check liveLocation.city first, then questionnaire.city
    if (city) {
      f.$or = [
        { 'liveLocation.city': city },
        { 'questionnaire.city': city },
      ];
    }
    if (state) f.$or = [
      { 'liveLocation.state': state },
      { 'questionnaire.state': state },
    ];
    const companions = await User.find(f)
      .select('firstName lastName profilePhoto questionnaire liveLocation ratingStats verified isPremium userType')
      .limit(parseInt(limit)).sort({ isPremium: -1, 'ratingStats.averageRating': -1, lastActive: -1 });
    res.json({ success: true, companions });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/:companionId', auth, async (req, res) => {
  try {
    const c = await User.findOne({ _id: req.params.companionId, userType: 'COMPANION', status: 'ACTIVE' })
      .select('-password -emailVerificationOTP -fcmTokens');
    if (!c) return res.status(404).json({ success: false, message: 'Companion not found' });
    res.json({ success: true, companion: c.getPublicProfile() });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

module.exports = router;
