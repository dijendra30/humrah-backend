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

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1&zoom=18`;
    const response = await fetch(url, { headers: { 'User-Agent': 'HumrahApp/1.0 (contact@humrah.com)' } });
    if (!response.ok) return null;
    const data = await response.json();
    return data.address || null;
  } catch(e) {
    console.error("Geocoding failed:", e);
    return null;
  }
}

// ── POST /api/users/matchmaking-location ─────────────────────────────────────
// Body: { lat, lng, city, state }
// 1. Updates user.liveLocation
// 2. If city differs from questionnaire.city → silently updates questionnaire.city + questionnaire.state
router.post('/', async (req, res) => {
  try {
    const { lat, lng, city, state } = req.body;

    if (lat === undefined || lng === undefined)
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ success: false, message: 'Invalid coordinates' });

    const now  = new Date();
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    // ── Server-side staleness guard ──────────────────────────────────────────
    const user = await User.findById(req.userId).select('liveLocation last_known_lat last_known_lng questionnaire').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const ll       = user.liveLocation;
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
        liveLocation:       ll,
        profileCityUpdated: false,
        profileCity:        user.questionnaire?.city  || null,
        profileState:       user.questionnaire?.state || null,
      });
    }

    const needsGeocoding = hasMovedSignificantly || age >= ONE_DAY_MS || !ll?.displayName;
    
    let area = ll?.area || null;
    let district = ll?.district || null;
    let geocodedCity = ll?.city || city || null;
    let geocodedState = ll?.state || state || null;
    let country = ll?.country || null;
    let displayName = ll?.displayName || null;

    if (needsGeocoding) {
      const addr = await reverseGeocode(lat, lng);
      if (addr) {
        area = addr.neighbourhood || addr.suburb || addr.quarter || addr.residential || addr.road || null;
        district = addr.city_district || addr.county || null;
        geocodedCity = addr.city || addr.town || addr.municipality || null;
        geocodedState = addr.state || null;
        country = addr.country || null;

        if (area && geocodedCity) {
          displayName = `${area}, ${geocodedCity}`;
        } else if (district && geocodedCity) {
          displayName = `${district}, ${geocodedCity}`;
        } else if (geocodedCity) {
          displayName = geocodedCity;
        } else if (area) {
          displayName = area;
        } else {
          displayName = geocodedState || "Unknown Location";
        }
      }
    }

    const $set = {
      'liveLocation.type':        'Point',
      'liveLocation.coordinates': [Number(lng), Number(lat)],
      'liveLocation.lat':         Number(lat),
      'liveLocation.lng':         Number(lng),
      'liveLocation.area':        area,
      'liveLocation.district':    district,
      'liveLocation.city':        geocodedCity,
      'liveLocation.state':       geocodedState,
      'liveLocation.country':     country,
      'liveLocation.displayName': displayName,
      'liveLocation.updatedAt':   now,

      last_known_lat:           Number(lat),
      last_known_lng:           Number(lng),
      last_location_updated_at: now
    };

    const updated = await User.findByIdAndUpdate(
      req.userId,
      { $set },
      { new: true, select: 'liveLocation questionnaire' }
    );

    console.log(`[matchmaking-location] updated for ${req.userId}: (${lat}, ${lng}) displayName=${displayName || '?'}`);

    res.json({
      success:            true,
      cached:             false,
      liveLocation:       updated.liveLocation,
      profileCityUpdated: false,
      profileCity:        updated.questionnaire?.city  || null,
      profileState:       updated.questionnaire?.state || null,
      message:            'Live location updated successfully'
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
