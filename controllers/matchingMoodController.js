// controllers/matchingMoodController.js
// Handles Matching Today Mood feature.
// Three operations:
//   1. appOpen   — update location, resolve nearby cache, return state
//   2. goLive    — set mood visible (does NOT re-fetch nearby)
//   3. getState  — return current mood + nearbyData
'use strict';

const MatchingTodayMood = require('../models/MatchingTodayMood');
const { toLocationHash, resolveNearbyData } = require('../services/nearbyPlaceService');

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MOODS = new Set([
  'Cafe Mood', 'Food Mood', 'Walk Mood', 'Talk Mood', 'Study Mood',
  'Explore Mood', 'Chill Mood', 'Drive Mood', 'Photo Mood', 'Shop Mood',
  'Night Mood', 'Fitness Mood',
]);

const VALID_VIBE_LEVELS = new Set(['lowkey', 'normal', 'social']);

// ─────────────────────────────────────────────────────────────────────────────
// 1. APP OPEN
//    POST /api/matching-mood/app-open
//    Body: { lat, lng }
//
//    Flow:
//    - generate locationHash
//    - find or init MatchingTodayMood doc for user
//    - check nearbyData cache
//    - if stale / missing / area changed → fetch Overpass, save
//    - return full state (mood + nearbyData)
// ─────────────────────────────────────────────────────────────────────────────

exports.appOpen = async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'Invalid coordinates' });
    }

    const locationHash = toLocationHash(lat, lng);

    // Find or create doc (no upsert yet — check cache first)
    let moodDoc = await MatchingTodayMood.findOne({ userId: req.userId });

    if (!moodDoc) {
      // First time — create minimal doc, fetch nearby below
      moodDoc = new MatchingTodayMood({
        userId: req.userId,
        locationHash,
        updatedAt: new Date(0), // force fetch
      });
    }

    // Resolve nearby data (cache hit or fresh Overpass fetch)
    const nearbyResult = await resolveNearbyData(moodDoc, lat, lng, locationHash);

    // Update doc fields
    moodDoc.locationHash = locationHash;
    moodDoc.nearbyData   = { count: nearbyResult.count, places: nearbyResult.places };
    moodDoc.updatedAt    = new Date();

    await moodDoc.save();

    // Check if mood is still active
    const now = new Date();
    const moodActive = moodDoc.visible && moodDoc.expiresAt && moodDoc.expiresAt > now;

    return res.json({
      success:      true,
      locationHash,
      nearbyData:   moodDoc.nearbyData,
      fromCache:    nearbyResult.fromCache,
      moodState: {
        mood:      moodDoc.mood,
        vibeLevel: moodDoc.vibeLevel,
        intention: moodDoc.intention,
        visible:   moodActive ? moodDoc.visible : false,
        expiresAt: moodDoc.expiresAt,
        isActive:  !!moodActive,
      },
    });

  } catch (err) {
    console.error('❌ [MatchingMood] appOpen error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GO LIVE
//    PUT /api/matching-mood/go-live
//    Body: { mood, vibeLevel?, intention? }
//
//    Flow:
//    - validate mood
//    - update only: mood, visible, vibeLevel, intention, expiresAt
//    - nearby stays as-is (already set on app open)
// ─────────────────────────────────────────────────────────────────────────────

exports.goLive = async (req, res) => {
  try {
    const { mood, vibeLevel = 'normal', intention = null } = req.body;

    if (!mood) {
      return res.status(400).json({ success: false, message: 'mood is required' });
    }
    if (!VALID_MOODS.has(mood)) {
      return res.status(400).json({ success: false, message: 'Invalid mood value' });
    }
    if (!VALID_VIBE_LEVELS.has(vibeLevel)) {
      return res.status(400).json({ success: false, message: 'Invalid vibeLevel. Use: lowkey | normal | social' });
    }

    const now      = new Date();
    const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4h

    // Upsert: create doc if somehow missing, else update mood fields only
    const moodDoc = await MatchingTodayMood.findOneAndUpdate(
      { userId: req.userId },
      {
        $set: {
          mood,
          vibeLevel,
          intention,
          visible:   true,
          expiresAt,
          updatedAt: now,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({
      success: true,
      message: '✨ You are now live',
      moodState: {
        mood:      moodDoc.mood,
        vibeLevel: moodDoc.vibeLevel,
        intention: moodDoc.intention,
        visible:   moodDoc.visible,
        expiresAt: moodDoc.expiresAt,
        isActive:  true,
      },
      // Return nearbyData so UI can display it immediately without extra call
      nearbyData: moodDoc.nearbyData,
    });

  } catch (err) {
    console.error('❌ [MatchingMood] goLive error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET STATE
//    GET /api/matching-mood/state
//    Returns current mood + nearbyData for the authenticated user
// ─────────────────────────────────────────────────────────────────────────────

exports.getState = async (req, res) => {
  try {
    const moodDoc = await MatchingTodayMood.findOne({ userId: req.userId }).lean();

    if (!moodDoc) {
      return res.json({
        success:   true,
        isActive:  false,
        moodState: null,
        nearbyData: { count: 0, places: [] },
      });
    }

    const now      = new Date();
    const isActive = moodDoc.visible && moodDoc.expiresAt && new Date(moodDoc.expiresAt) > now;

    return res.json({
      success: true,
      isActive: !!isActive,
      moodState: {
        mood:      moodDoc.mood,
        vibeLevel: moodDoc.vibeLevel,
        intention: moodDoc.intention,
        visible:   isActive ? moodDoc.visible : false,
        expiresAt: moodDoc.expiresAt,
        isActive:  !!isActive,
      },
      nearbyData: moodDoc.nearbyData || { count: 0, places: [] },
      locationHash: moodDoc.locationHash,
    });

  } catch (err) {
    console.error('❌ [MatchingMood] getState error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. GO OFFLINE (optional — hide user from feed without deleting)
//    PUT /api/matching-mood/go-offline
// ─────────────────────────────────────────────────────────────────────────────

exports.goOffline = async (req, res) => {
  try {
    await MatchingTodayMood.findOneAndUpdate(
      { userId: req.userId },
      { $set: { visible: false, updatedAt: new Date() } }
    );
    return res.json({ success: true, message: 'You are now hidden from the feed' });
  } catch (err) {
    console.error('❌ [MatchingMood] goOffline error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
