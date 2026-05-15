// routes/companions.js
'use strict';

const express = require('express');
const https   = require('https');
const qs      = require('querystring');
const router  = express.Router();

const { auth, authenticate } = require('../middleware/auth');
const User                = require('../models/User');
const DailyMood           = require('../models/DailyMood');
const NearbyLocationCache = require('../models/NearbyLocationCache');
const admin               = require('firebase-admin');

// =============================================================================
// HELPERS
// =============================================================================

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dL = (lat2-lat1)*Math.PI/180, dG = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getRadiusKm()  { const h = new Date().getHours(); return (h >= 21 || h < 6) ? 2 : 5; }
function isNightTime()  { const h = new Date().getHours(); return h >= 21 || h < 6; }

// locationHash: 2-decimal precision (~1 km grid cell, shared across users in same area)
function locationHash(lat, lng) {
  return `${Math.round(lat * 100) / 100}_${Math.round(lng * 100) / 100}`;
}

// =============================================================================
// CITY FALLBACK COORDS
// =============================================================================

const CITY_COORDS = {
  'Delhi':[28.6139,77.2090],'New Delhi':[28.6139,77.2090],
  'Mumbai':[19.0760,72.8777],'Bangalore':[12.9716,77.5946],
  'Bengaluru':[12.9716,77.5946],'Hyderabad':[17.3850,78.4867],
  'Chennai':[13.0827,80.2707],'Kolkata':[22.5726,88.3639],
  'Pune':[18.5204,73.8567],'Ahmedabad':[23.0225,72.5714],
  'Jaipur':[26.9124,75.7873],'Surat':[21.1702,72.8311],
  'Lucknow':[26.8467,80.9462],'Kanpur':[26.4499,80.3319],
  'Nagpur':[21.1458,79.0882],'Indore':[22.7196,75.8577],
  'Bhopal':[23.2599,77.4126],'Patna':[25.5941,85.1376],
  'Noida':[28.5355,77.3910],'Gurgaon':[28.4595,77.0266],
  'Gurugram':[28.4595,77.0266],'Faridabad':[28.4089,77.3178],
  'Chandigarh':[30.7333,76.7794],'Coimbatore':[11.0168,76.9558],
  'Kochi':[9.9312,76.2673],'Bhubaneswar':[20.2961,85.8245],
  'Guwahati':[26.1445,91.7362],'Visakhapatnam':[17.6868,83.2185],
};

// =============================================================================
// OSM MOOD CONFIG
// =============================================================================

const MOOD_OSM = {
  'Cafe Mood':    {q:[['amenity','cafe|coffee_shop|bakery']],                                                                                              label:'cafes',          r:2000, fb:5000},
  'Food Mood':    {q:[['amenity','restaurant|food_court|fast_food|bar']],                                                                                  label:'food places',    r:2000, fb:5000},
  'Walk Mood':    {q:[['leisure','park|garden|nature_reserve|playground']],                                                                                label:'parks',          r:4000, fb:8000},
  'Talk Mood':    {q:[['amenity','cafe|community_centre|library|restaurant']],                                                                             label:'spots',          r:3000, fb:6000},
  'Study Mood':   {q:[['amenity','library|cafe|university|college']],                                                                                      label:'study spots',    r:3000, fb:6000},
  'Explore Mood': {q:[['tourism','attraction|museum|viewpoint|gallery|theme_park|zoo'],['historic','monument|memorial|fort'],['railway','station']],       label:'explore spots',  r:5000, fb:10000},
  'Chill Mood':   {q:[['leisure','park|garden|pitch|nature_reserve']],                                                                                     label:'chill spots',    r:4000, fb:8000},
  'Photo Mood':   {q:[['tourism','attraction|viewpoint|museum|artwork|gallery'],['historic','monument|memorial|fort'],['natural','peak|water|wood|cliff|beach'],['leisure','park|garden']], label:'photo spots', r:5000, fb:10000},
  'Shop Mood':    {q:[['shop','mall|supermarket|department_store|clothes'],['amenity','marketplace']],                                                     label:'shopping spots', r:3000, fb:6000},
  'Night Mood':   {q:[['amenity','cafe|bar|cinema|restaurant|theatre']],                                                                                   label:'safe spots',     r:2000, fb:4000},
  'Fitness Mood': {q:[['leisure','fitness_centre|sports_centre|pitch|stadium|swimming_pool'],['amenity','gym'],['sport','fitness|gym|swimming|tennis']],   label:'fitness spots',  r:3000, fb:6000},
};

// =============================================================================
// OVERPASS HELPERS
// =============================================================================

function _buildQuery(lat, lng, r, queries) {
  const parts = queries.map(([k, v]) =>
    `node(around:${r},${lat},${lng})["${k}"~"${v}"];way(around:${r},${lat},${lng})["${k}"~"${v}"];`
  ).join('');
  return `[out:json][timeout:15];(${parts});out tags 30;`;
}

function _parse(body) {
  const count = (body.match(/"type"\s*:\s*"(node|way)"/g) || []).length;
  const nm    = [...body.matchAll(/"name"\s*:\s*"([^"]+)"/g)];
  const names = [...new Set(nm.map(m => m[1].trim()).filter(Boolean))].slice(0, 3);
  return { count, names };
}

function _runQuery(lat, lng, r, queries) {
  return new Promise(resolve => {
    const data = qs.stringify({ data: _buildQuery(lat, lng, r, queries) });
    const opts = {
      hostname: 'overpass-api.de', path: '/api/interpreter', method: 'POST', timeout: 14000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(_parse(body)); } catch { resolve({ count: 0, names: [] }); } });
    });
    req.on('error',   () => resolve({ count: 0, names: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ count: 0, names: [] }); });
    req.write(data); req.end();
  });
}

async function _fetchMood(lat, lng, cfg, night) {
  const initR = night ? Math.min(cfg.r, 2000) : cfg.r;
  const first = await _runQuery(lat, lng, initR, cfg.q);
  if (first.count >= 3) return { ...first, label: cfg.label };
  const second = await _runQuery(lat, lng, cfg.fb, cfg.q);
  return { ...(second.count > first.count ? second : first), label: cfg.label };
}

// =============================================================================
// GET /api/companions/mood-places
//
// Flow:
//   1. Frontend sends coordinates (already stored on User from location update)
//   2. Backend generates locationHash
//   3. Check NearbyLocationCache collection
//   4a. Cache hit → return instantly
//   4b. Cache miss → fetch Overpass for all moods in parallel → save → return
//
// This is the ONLY place where Overpass is called.
// NOT called on mood chip tap, NOT on bottom sheet open, NOT on Go Live.
// =============================================================================

router.get('/mood-places', authenticate, async (req, res) => {
  try {
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng questionnaire').lean();
    if (!me) return res.json({ success: false, places: {}, message: 'User not found' });

    let lat = me.last_known_lat, lng = me.last_known_lng;

    // City-coord fallback when GPS not yet saved
    if (lat == null || lng == null) {
      const city   = me.questionnaire?.city?.trim();
      const coords = city ? CITY_COORDS[city] : null;
      if (!coords) return res.json({ success: true, places: {}, cached: false, message: 'location_pending' });
      [lat, lng] = coords;
    }

    const hash = locationHash(lat, lng);

    // ── Cache lookup in NearbyLocationCache collection ──────────────────────
    const cached = await NearbyLocationCache.findOne({ locationHash: hash }).lean();
    if (cached && cached.places) {
      return res.json({ success: true, places: cached.places, cached: true });
    }

    // ── Cache miss — fetch Overpass for all moods in parallel ───────────────
    const night = isNightTime();
    const settled = await Promise.allSettled(
      Object.entries(MOOD_OSM).map(([mk, cfg]) =>
        _fetchMood(lat, lng, cfg, night)
          .then(r  => ({ mk, count: r.count, names: r.names, label: r.label }))
          .catch(() => ({ mk, count: 0, names: [], label: cfg.label }))
      )
    );

    const places = {};
    settled.forEach(r => {
      if (r.status === 'fulfilled') {
        const { mk, count, names, label } = r.value;
        places[mk] = { count, names, label };
      }
    });

    // ── Persist to NearbyLocationCache (24h TTL, shared across users) ───────
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await NearbyLocationCache.findOneAndUpdate(
      { locationHash: hash },
      { locationHash: hash, lat, lng, places, fetchedAt: new Date(), expiresAt },
      { upsert: true, new: true }
    );

    return res.json({ success: true, places, cached: false });
  } catch (err) {
    console.error('[mood-places]', err.message);
    res.status(500).json({ success: false, places: {}, message: 'Server error' });
  }
});

// =============================================================================
// GET /api/companions/mood-matches
// Reads active moods from DailyMood collection (not User.dailyMood)
// Falls back to User.dailyMood for backward compatibility during migration
// =============================================================================

function calcCompatScore(me, other, maxKm) {
  // Use DailyMood fields when available, fall back to User.dailyMood
  const mm = me._dm   || me.dailyMood   || {};
  const om = other._dm || other.dailyMood || {};

  const myMoods  = mm.moods  || (mm.mood  ? [mm.mood]  : []);
  const othMoods = om.moods  || (om.mood  ? [om.mood]  : []);
  const myEnergy = mm.energyLevel || _vibeToEnergy(mm.vibeLevel) || 5;
  const othEnergy= om.energyLevel || _vibeToEnergy(om.vibeLevel) || 5;
  const myOpen   = mm.openTo || (mm.preferredPlace ? [mm.preferredPlace] : []);
  const othOpen  = om.openTo || (om.preferredPlace ? [om.preferredPlace] : []);

  const moodM  = (myMoods.filter(m => othMoods.includes(m)).length / (Math.max(myMoods.length, othMoods.length) || 1)) * 40;
  const energM = Math.max(0, 1 - Math.abs(myEnergy - othEnergy) / 9) * 25;
  const openM  = (myOpen.filter(a => othOpen.includes(a)).length / (Math.max(myOpen.length, othOpen.length) || 1)) * 20;

  const myI  = me.questionnaire?.interests || me.questionnaire?.hangoutPreferences || [];
  const thI  = other.questionnaire?.interests || other.questionnaire?.hangoutPreferences || [];
  const intM = (myI.filter(i => thI.includes(i)).length / (Math.max(myI.length, thI.length) || 1)) * 10;

  const distKm = haversineKm(me.last_known_lat, me.last_known_lng, other.last_known_lat, other.last_known_lng);
  const distB  = Math.max(0, 1 - distKm / maxKm) * 5;

  return Math.round(moodM + energM + openM + intM + distB);
}

function _vibeToEnergy(vibe) {
  if (!vibe) return null;
  const map = { lowkey: 3, normal: 6, social: 9 };
  return map[vibe.toLowerCase()] || null;
}

router.get('/mood-matches', authenticate, async (req, res) => {
  try {
    const now = new Date(), MAX_KM = getRadiusKm(), night = isNightTime();

    // ── Fetch requesting user ────────────────────────────────────────────────
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng last_location_updated_at dailyMood questionnaire blockedUsers status').lean();
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    // ── Check active mood in DailyMood collection first, fall back to User.dailyMood ──
    const myDM = await DailyMood.findOne({ userId: req.userId, expiresAt: { $gt: now } }).lean();

    // If neither DailyMood doc nor User.dailyMood is active → no mood set
    const legacyActive = me.dailyMood?.expiresAt && new Date(me.dailyMood.expiresAt) > now;
    if (!myDM && !legacyActive) {
      return res.json({ success: true, users: [], noMoodSet: true, message: 'Set your mood first' });
    }

    // Attach active mood to me for compat scoring
    me._dm = myDM || null;

    // ── Location check ───────────────────────────────────────────────────────
    const locationAge = me.last_location_updated_at
      ? (now - new Date(me.last_location_updated_at)) / 3600000 : 999;
    if (locationAge > 24 || me.last_known_lat == null) {
      return res.json({ success: true, users: [], noMoodSet: false, message: 'Share your location to find matches' });
    }

    // ── Bounding-box candidate query ─────────────────────────────────────────
    const blockedIds = (me.blockedUsers || []).map(id => id.toString());
    const dLat = MAX_KM / 111.0;
    const dLng = MAX_KM / (111.0 * Math.cos(me.last_known_lat * Math.PI / 180));

    // Find users with active DailyMood documents in this area
    const activeDMs = await DailyMood.find({
      userId:    { $ne: req.userId },
      expiresAt: { $gt: now },
      visible:   true
    }).select('userId mood vibeLevel preferredPlace intention').lean();

    const activeUserIds = activeDMs.map(d => d.userId.toString()).filter(id => !blockedIds.includes(id));

    // Also include legacy User.dailyMood users in the same bounding box
    const candidates = await User.find({
      _id: { $in: activeUserIds.length > 0 ? activeUserIds : ['000000000000000000000000'],
             $ne: req.userId, $nin: blockedIds },
      status: 'ACTIVE',
      last_location_updated_at: { $gte: new Date(now - 86400000) },
      last_known_lat: { $gte: me.last_known_lat - dLat, $lte: me.last_known_lat + dLat },
      last_known_lng: { $gte: me.last_known_lng - dLng, $lte: me.last_known_lng + dLng },
    }).select('firstName age profilePhoto verified photoVerificationStatus last_known_lat last_known_lng dailyMood questionnaire').lean();

    // Also check legacy users in bounding box who haven't migrated to DailyMood
    const legacyCandidates = await User.find({
      _id: { $ne: req.userId, $nin: [...blockedIds, ...activeUserIds] },
      status: 'ACTIVE',
      last_location_updated_at: { $gte: new Date(now - 86400000) },
      last_known_lat: { $gte: me.last_known_lat - dLat, $lte: me.last_known_lat + dLat },
      last_known_lng: { $gte: me.last_known_lng - dLng, $lte: me.last_known_lng + dLng },
      'dailyMood.expiresAt': { $gt: now },
      'dailyMood.visible': true,
    }).select('firstName age profilePhoto verified photoVerificationStatus last_known_lat last_known_lng dailyMood questionnaire').lean();

    const allCandidates = [...candidates, ...legacyCandidates];

    // Attach DailyMood doc to each candidate for compat scoring
    const dmByUser = {};
    activeDMs.forEach(d => { dmByUser[d.userId.toString()] = d; });
    allCandidates.forEach(c => { c._dm = dmByUser[c._id.toString()] || null; });

    // ── Filter by exact radius + build result ────────────────────────────────
    const results = [];
    for (const c of allCandidates) {
      if (c.last_known_lat == null || c.last_known_lng == null) continue;
      const distKm = haversineKm(me.last_known_lat, me.last_known_lng, c.last_known_lat, c.last_known_lng);
      if (distKm > MAX_KM) continue;

      const dm = c._dm || c.dailyMood;
      const moodKey = dm?.mood || dm?.moods?.[0] || null;

      results.push({
        _id:                     c._id,
        firstName:               c.firstName,
        age:                     c.age || null,
        profilePhoto:            c.profilePhoto,
        verified:                c.verified,
        photoVerificationStatus: c.photoVerificationStatus || null,
        distanceKm:              Math.round(distKm * 10) / 10,
        compatibilityScore:      calcCompatScore(me, c, MAX_KM),
        dailyMood: {
          moods:       moodKey ? [moodKey] : (c.dailyMood?.moods || []),
          energyLevel: dm?.energyLevel || _vibeToEnergy(dm?.vibeLevel) || c.dailyMood?.energyLevel,
          openTo:      dm?.openTo || (dm?.preferredPlace ? [dm.preferredPlace] : c.dailyMood?.openTo || [])
        }
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
      expiresAt: myDM?.expiresAt || me.dailyMood?.expiresAt
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

    const now = new Date(), MAX_KM = getRadiusKm();

    const [me, receiver] = await Promise.all([
      User.findById(req.userId).select('last_known_lat last_known_lng dailyMood blockedUsers firstName moodRequestsSent').lean(),
      User.findById(receiverId).select('last_known_lat last_known_lng dailyMood blockedUsers fcmTokens firstName').lean()
    ]);

    if (!receiver) return res.status(404).json({ success: false, message: 'User not found' });

    // Check DailyMood collection first, then fall back to User.dailyMood
    const [myDM, recDM] = await Promise.all([
      DailyMood.findOne({ userId: req.userId,  expiresAt: { $gt: now } }).lean(),
      DailyMood.findOne({ userId: receiverId,   expiresAt: { $gt: now } }).lean()
    ]);

    const meActive  = myDM  || (me.dailyMood?.expiresAt  && new Date(me.dailyMood.expiresAt)  > now);
    const recActive = recDM || (receiver.dailyMood?.expiresAt && new Date(receiver.dailyMood.expiresAt) > now);

    if (!meActive || !recActive) {
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
          android:      { priority: 'normal' }
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
    const u = await User.findById(req.userId);
    if (!u?.questionnaire) return res.status(400).json({ success: false, message: 'Complete your profile first' });
    const f = { _id: { $ne: req.userId }, userType: 'COMPANION', status: 'ACTIVE' };
    if (u.questionnaire.city) f['questionnaire.city'] = u.questionnaire.city;
    if (u.questionnaire.interests?.length) f['questionnaire.interests'] = { $in: u.questionnaire.interests };
    const companions = await User.find(f)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(10).sort({ 'ratingStats.averageRating': -1, lastActive: -1 });
    res.json({ success: true, companions });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/', auth, async (req, res) => {
  try {
    const { interests, city, state, limit = 20 } = req.query;
    const f = { _id: { $ne: req.userId }, userType: 'COMPANION', status: 'ACTIVE' };
    if (interests) f['questionnaire.interests'] = { $in: interests.split(',') };
    if (city)      f['questionnaire.city'] = city;
    if (state)     f['questionnaire.state'] = state;
    const companions = await User.find(f)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
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
