// routes/liveLocationMatchmaking.js
// Lightweight live location for matchmaking — NOT continuous tracking.
//
// Called only at:
//   1. App open (HomeActivity)
//   2. App resume after long background idle
//   3. When opening Surprise Meetup page
//   4. Before "Find My Match"
//   5. Before creating a meetup
//
// Endpoints (mounted at /api/users/matchmaking-location in server.js):
//   POST /        → update liveLocation + silently sync questionnaire.city/state
//   GET  /status  → freshness check
//
// Authentication is applied by server.js at mount time.
//
// CITY SYNC POLICY:
//   liveLocation is updated on every call.
//   questionnaire.city is NEVER touched here — it is static onboarding/profile data.
//   Realtime city (liveLocation.city) is used exclusively for nearby/matchmaking.
//   Distance filtering uses liveLocation.lat/lng via Haversine — NOT city name comparison.
'use strict';

const express = require('express');
const router  = express.Router();
const User    = require('../models/User');

// ── Constants ──────────────────────────────────────────────────────────────────
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

// ── POST /api/users/matchmaking-location ─────────────────────────────────────
// Body: { lat, lng, city, state }
// 1. Updates user.liveLocation
// 2. If city differs from questionnaire.city → silently updates questionnaire.city + questionnaire.state
router.post('/', async (req, res) => {
  try {
    const { lat, lng, city, state } = req.body;

    // ── Validate coords ────────────────────────────────────────────────────────
    if (lat === undefined || lat === null || lng === undefined || lng === null) {
      return res.status(400).json({ success: false, message: 'lat and lng are required.' });
    }
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (isNaN(latNum) || isNaN(lngNum)) {
      return res.status(400).json({ success: false, message: 'lat and lng must be numbers.' });
    }
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      return res.status(400).json({ success: false, message: 'Invalid GPS coordinates.' });
    }

    const now = new Date();

    // ── Build the update ───────────────────────────────────────────────────────
    const $set = {
      // liveLocation — matchmaking / freshness tracking
      'liveLocation.lat':       latNum,
      'liveLocation.lng':       lngNum,
      'liveLocation.city':      city  || null,
      'liveLocation.state':     state || null,
      'liveLocation.updatedAt': now,
      // Legacy flat fields — keep in sync so older code paths still work
      last_known_lat:           latNum,
      last_known_lng:           lngNum,
      last_location_updated_at: now,
    };

    // questionnaire.city / questionnaire.state are NEVER modified here.
    // They remain as the user's original onboarding profile city.
    // All realtime/nearby features must read from liveLocation.city / liveLocation.lat / liveLocation.lng.
    const profileCityUpdated = false;

    // ── Atomic update ──────────────────────────────────────────────────────────
    const updated = await User.findByIdAndUpdate(
      req.userId,
      { $set },
      { new: true, select: 'liveLocation questionnaire' }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.json({
      success:            true,
      liveLocation:       updated.liveLocation,
      profileCityUpdated: false,
      // profileCity reflects the static onboarding city — NOT the live location
      profileCity:        updated.questionnaire?.city  || null,
      profileState:       updated.questionnaire?.state || null,
    });

  } catch (err) {
    console.error('❌ matchmaking-location update error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/users/matchmaking-location/status ───────────────────────────────
// Returns whether the current user's live location is fresh or stale.
// Used by the frontend to decide whether to prompt a GPS refresh before matchmaking.
router.get('/status', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('liveLocation questionnaire');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const ll = user.liveLocation;
    const hasLiveLocation = !!(ll && ll.lat != null && ll.lng != null);
    let isStale    = true;
    let minutesOld = null;

    if (hasLiveLocation && ll.updatedAt) {
      const ageMs = Date.now() - new Date(ll.updatedAt).getTime();
      minutesOld  = Math.floor(ageMs / 60000);
      isStale     = ageMs > STALE_THRESHOLD_MS;
    }

    // profileCity always reflects the current questionnaire city
    // (kept in sync by the POST endpoint above)
    const profileCity  = user.questionnaire?.city  || null;
    const profileState = user.questionnaire?.state || null;

    return res.json({
      success:         true,
      hasLiveLocation,
      isStale,
      minutesOld,
      liveLocation:    hasLiveLocation ? ll : null,
      profileCity,
      profileState,
      needsRefresh:    !hasLiveLocation || isStale,
    });

  } catch (err) {
    console.error('❌ matchmaking-location status error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
