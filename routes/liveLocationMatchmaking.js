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
//   POST /        → atomic geocode-first liveLocation update (never touches questionnaire.city)
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
// ✅ Shared atomic geocode-first update — the SAME logic used by
//    POST /api/users/location, so lat/lng and city/state can never diverge
//    between the two endpoints. See services/liveLocationService.js.
const { updateUserLiveLocation } = require('../services/liveLocationService');

// ── Constants ──────────────────────────────────────────────────────────────────
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2-lat1) * (Math.PI/180);
  const dLon = (lon2-lon1) * (Math.PI/180); 
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c; 
}

// ── POST /api/users/matchmaking-location ─────────────────────────────────────
// Body: { lat, lng }
router.post('/', async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined)
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ success: false, message: 'Invalid coordinates' });

    const now  = new Date();
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;

    // ── Server-side staleness guard ──────────────────────────────────────────
    const user = await User.findById(req.userId).select('liveLocation last_known_lat last_known_lng questionnaire').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const ll       = user.liveLocation || {};
    const lastUpd  = ll?.updatedAt ? new Date(ll.updatedAt).getTime() : 0;
    const age      = now.getTime() - lastUpd;
    
    const distKm = getDistanceFromLatLonInKm(ll?.lat || 0, ll?.lng || 0, lat, lng);
    const hasMovedSignificantly = distKm > 0.5; // 500 meters

    // Avoid unnecessary DB writes if less than 15 mins and < 500m
    if (age < FIFTEEN_MIN_MS && !hasMovedSignificantly && ll?.displayName) {
      return res.json({
        success:            true,
        cached:             true,
        message:            'Location is still fresh',
        liveLocation:       ll
      });
    }

    // ── Atomic geocode-first update (shared with POST /api/users/location) ──
    // Reverse geocoding happens FIRST inside this call; lat/lng and
    // area/city/state/displayName are written together in a single
    // findByIdAndUpdate. If geocoding fails, nothing is overwritten.
    const result = await updateUserLiveLocation(req.userId, lat, lng);

    if (!result.success) {
      // Geocoding failed — old city/state/displayName were left untouched.
      return res.status(503).json({
        success:      false,
        message:      result.message || 'Reverse geocoding failed. Please try again later.',
        retry:        true,
        liveLocation: result.liveLocation || ll
      });
    }

    res.json({
      success:      true,
      cached:       false,
      liveLocation: result.liveLocation,
      message:      'Live location updated successfully'
    });
  } catch (error) {
    console.error('❌ matchmaking-location update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating location' });
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
