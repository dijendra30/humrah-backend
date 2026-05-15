// controllers/matchingMoodController.js
// Single collection: MatchingTodayMood
// appOpen  → updates locationHash + nearbyData (cache check first)
// goLive   → updates mood/visible/vibeLevel/intention only
// goOffline→ sets visible = false
// getState → returns current doc
'use strict';

const MatchingTodayMood = require('../models/MatchingTodayMood');
const { toLocationHash, fetchNearbyFromOverpass, CACHE_TTL_MS } = require('../services/nearbyPlaceService');

const VALID_MOODS = new Set(['Cafe Mood','Food Mood','Walk Mood','Talk Mood','Study Mood','Explore Mood','Chill Mood','Drive Mood','Photo Mood','Shop Mood','Night Mood','Fitness Mood']);
const VALID_VIBE  = new Set(['lowkey','normal','social']);

// ── 1. APP OPEN ───────────────────────────────────────────────────────────────
// POST /api/matching-mood/app-open  { lat, lng }
// - generates locationHash
// - checks MatchingTodayMood.nearbyData cache
// - fetches Overpass ONLY if cache missing/stale/area changed
// - saves nearbyData into the user's doc
// - returns nearbyData + current mood state
exports.appOpen = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined)
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ success: false, message: 'Invalid coordinates' });

    const locationHash = toLocationHash(lat, lng);
    const now          = new Date();

    // Find existing doc (no upsert yet — check cache first)
    let doc = await MatchingTodayMood.findOne({ userId: req.userId });

    // Cache validity check
    const cacheAge    = doc?.updatedAt ? now - doc.updatedAt : Infinity;
    const hashChanged = doc?.locationHash !== locationHash;
    const hasCache    = doc?.nearbyData?.count > 0;
    const cacheValid  = hasCache && !hashChanged && cacheAge < CACHE_TTL_MS;

    let nearbyData = doc?.nearbyData || { count: 0, places: [] };
    let fromCache  = cacheValid;

    if (!cacheValid) {
      // Fetch from Overpass
      nearbyData = await fetchNearbyFromOverpass(lat, lng);

      if (doc) {
        doc.locationHash = locationHash;
        doc.nearbyData   = nearbyData;
        doc.updatedAt    = now;
        await doc.save();
      } else {
        doc = await MatchingTodayMood.create({
          userId: req.userId,
          locationHash,
          nearbyData,
          updatedAt: now,
        });
      }
    }

    // Mood active check
    const moodActive = doc.visible && doc.expiresAt && doc.expiresAt > now;

    return res.json({
      success: true,
      locationHash,
      fromCache,
      nearbyData,
      moodState: moodActive ? {
        mood:      doc.mood,
        vibeLevel: doc.vibeLevel,
        intention: doc.intention,
        visible:   doc.visible,
        expiresAt: doc.expiresAt,
        isActive:  true,
      } : null,
    });

  } catch (err) {
    console.error('❌ [MatchingMood] appOpen:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 2. GO LIVE ────────────────────────────────────────────────────────────────
// PUT /api/matching-mood/go-live  { mood, vibeLevel?, intention? }
// - updates ONLY mood state fields
// - nearby data stays untouched
exports.goLive = async (req, res) => {
  try {
    const { mood, vibeLevel = 'normal', intention = null } = req.body;

    if (!mood)                      return res.status(400).json({ success: false, message: 'mood is required' });
    if (!VALID_MOODS.has(mood))     return res.status(400).json({ success: false, message: 'Invalid mood' });
    if (!VALID_VIBE.has(vibeLevel)) return res.status(400).json({ success: false, message: 'vibeLevel must be lowkey | normal | social' });

    const now       = new Date();
    const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4h

    const doc = await MatchingTodayMood.findOneAndUpdate(
      { userId: req.userId },
      { $set: { mood, vibeLevel, intention, visible: true, expiresAt, updatedAt: now } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      success:   true,
      message:   '✨ You are now live',
      moodState: { mood: doc.mood, vibeLevel: doc.vibeLevel, intention: doc.intention, visible: doc.visible, expiresAt: doc.expiresAt, isActive: true },
      nearbyData: doc.nearbyData, // already cached — return for immediate UI use
    });

  } catch (err) {
    console.error('❌ [MatchingMood] goLive:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 3. GO OFFLINE ─────────────────────────────────────────────────────────────
// PUT /api/matching-mood/go-offline
exports.goOffline = async (req, res) => {
  try {
    await MatchingTodayMood.findOneAndUpdate(
      { userId: req.userId },
      { $set: { visible: false, updatedAt: new Date() } }
    );
    return res.json({ success: true, message: 'Hidden from feed' });
  } catch (err) {
    console.error('❌ [MatchingMood] goOffline:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 4. GET STATE ──────────────────────────────────────────────────────────────
// GET /api/matching-mood/state
exports.getState = async (req, res) => {
  try {
    const doc = await MatchingTodayMood.findOne({ userId: req.userId }).lean();
    if (!doc) return res.json({ success: true, isActive: false, moodState: null, nearbyData: { count: 0, places: [] } });

    const now      = new Date();
    const isActive = doc.visible && doc.expiresAt && new Date(doc.expiresAt) > now;

    return res.json({
      success:  true,
      isActive: !!isActive,
      moodState: isActive ? {
        mood:         doc.mood,
        vibeLevel:    doc.vibeLevel,
        intention:    doc.intention,
        visible:      doc.visible,
        locationHash: doc.locationHash,
        expiresAt:    doc.expiresAt,
        isActive:     true,
      } : null,
      nearbyData:   doc.nearbyData || { count: 0, places: [] },
      locationHash: doc.locationHash,
    });

  } catch (err) {
    console.error('❌ [MatchingMood] getState:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
