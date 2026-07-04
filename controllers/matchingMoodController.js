// controllers/matchingMoodController.js
'use strict';

const MatchingTodayMood  = require('../models/MatchingTodayMood');
const { toLocationHash, getAreaNearby, toLegacyShape } = require('../services/nearbyPlaceService');
// ✅ Atomic, geocode-first live location update — same single source of truth
// used by /api/users/location and /api/users/matchmaking-location.
// See services/liveLocationService.js for why this matters: writing lat/lng
// without also writing city/state/displayName in the SAME update is exactly
// what caused "lat/lng update instantly but city stays old".
const { updateUserLiveLocation } = require('../services/liveLocationService');

const VALID_MOODS = new Set([
  'Cafe Mood', 'Food Mood', 'Walk Mood', 'Talk Mood', 'Study Mood',
  'Explore Mood', 'Chill Mood', 'Photo Mood', 'Shop Mood',
  'Night Mood', 'Fitness Mood',
]);
const VALID_VIBE = new Set(['lowkey', 'normal', 'social']);

// ── 1. APP OPEN ───────────────────────────────────────────────────────────────
exports.appOpen = async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined)
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ success: false, message: 'Invalid coordinates' });

    // Get from shared area cache (cache-first, bg-refresh if stale)
    const { locationHash, moods, globalPlaces, fromCache, stale } = await getAreaNearby(lat, lng);

    const now = new Date();
    let doc = null; // populated by Promise.all below

    // Update user's locationHash on MatchingTodayMood
    // Also write liveLocation to User doc so /eligible and /nearby have fresh coords.
    // This is the primary location sync on every app open.
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    const User = require('mongoose').model('User');

    // Run in parallel: mood doc update + user liveLocation update
    await Promise.all([
      MatchingTodayMood.findOneAndUpdate(
        { userId: req.userId },
        { $set: { locationHash, updatedAt: now } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).then(d => { doc = d; }),
      // Only geocode+write liveLocation if it's stale (> 15 min) or moved meaningfully
      // — avoids hammering Nominatim on every single app open.
      // ⚠️ Always goes through the atomic service: lat/lng are NEVER written here
      // without area/city/state/displayName landing in the exact same DB write.
      User.findById(req.userId).select('liveLocation').lean().then(async u => {
        if (!u) return;
        const lastUpd = u.liveLocation?.updatedAt ? new Date(u.liveLocation.updatedAt).getTime() : 0;
        const age = now.getTime() - lastUpd;
        const latDiff = Math.abs((u.liveLocation?.lat || 0) - lat);
        const lngDiff = Math.abs((u.liveLocation?.lng || 0) - lng);
        if (age >= FIFTEEN_MIN_MS || latDiff > 0.001 || lngDiff > 0.001) {
          const result = await updateUserLiveLocation(req.userId, lat, lng);
          if (result.success) {
            console.log(`[appOpen] liveLocation updated for ${req.userId}: (${lat}, ${lng}) -> ${result.liveLocation?.displayName}`);
          } else {
            console.warn(`[appOpen] liveLocation update failed for ${req.userId} — previous location preserved, will retry next app open.`);
          }
        }
      })
    ]);

    const moodActive = !!(doc?.visible && doc?.expiresAt && doc.expiresAt > now);

    return res.json({
      success:      true,
      locationHash,
      fromCache,
      stale:        stale ?? false,
      nearbyData:   toLegacyShape(moods, globalPlaces),
      moodState: moodActive ? {
        mood: doc.mood, vibeLevel: doc.vibeLevel, intention: doc.intention,
        visible: doc.visible, expiresAt: doc.expiresAt, isActive: true,
      } : null,
    });

  } catch (err) {
    console.error('❌ [MatchingMood] appOpen:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 2. GO LIVE ────────────────────────────────────────────────────────────────
exports.goLive = async (req, res) => {
  try {
    const { mood, vibeLevel = 'normal', intention = null, visible = true } = req.body;

    if (!mood)                      return res.status(400).json({ success: false, message: 'mood is required' });
    if (!VALID_MOODS.has(mood))     return res.status(400).json({ success: false, message: 'Invalid mood' });
    if (!VALID_VIBE.has(vibeLevel)) return res.status(400).json({ success: false, message: 'vibeLevel must be lowkey | normal | social' });
    if (intention && intention.length > 100)
      return res.status(400).json({ success: false, message: 'intention too long (max 100 chars)' });

    const now       = new Date();
    const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);

    const doc = await MatchingTodayMood.findOneAndUpdate(
      { userId: req.userId },
      { $set: { mood, vibeLevel, intention, visible, expiresAt, updatedAt: now } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      success:   true,
      message:   '✨ You are now live',
      moodState: { mood: doc.mood, vibeLevel: doc.vibeLevel, intention: doc.intention, visible: doc.visible, expiresAt: doc.expiresAt, isActive: true },
    });

  } catch (err) {
    console.error('❌ [MatchingMood] goLive:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 3. GO OFFLINE ─────────────────────────────────────────────────────────────
exports.goOffline = async (req, res) => {
  try {
    await MatchingTodayMood.findOneAndUpdate(
      { userId: req.userId },
      { $set: { visible: false, mood: null, expiresAt: null, updatedAt: new Date() } }
    );
    return res.json({ success: true, message: 'Hidden from feed' });
  } catch (err) {
    console.error('❌ [MatchingMood] goOffline:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 4. GET STATE ──────────────────────────────────────────────────────────────
exports.getState = async (req, res) => {
  try {
    const doc = await MatchingTodayMood.findOne({ userId: req.userId }).lean();

    if (!doc) {
      return res.json({ success: true, isActive: false, moodState: null, nearbyData: null });
    }

    const now      = new Date();
    const isActive = !!(doc.visible && doc.expiresAt && new Date(doc.expiresAt) > now);

    return res.json({
      success:      true,
      isActive,
      moodState: isActive ? {
        mood: doc.mood, vibeLevel: doc.vibeLevel, intention: doc.intention,
        visible: doc.visible, locationHash: doc.locationHash,
        expiresAt: doc.expiresAt, isActive: true,
      } : null,
      locationHash: doc.locationHash,
    });

  } catch (err) {
    console.error('❌ [MatchingMood] getState:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
