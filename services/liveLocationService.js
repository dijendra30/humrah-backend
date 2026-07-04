// services/liveLocationService.js
//
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for atomic live-location updates.
//
// This exists because two separate code paths (routes/users.js "/location"
// and routes/liveLocationMatchmaking.js) used to update location differently:
//   - "/location" wrote ONLY last_known_lat/last_known_lng (no geocoding)
//   - "/matchmaking-location" reverse-geocoded THEN wrote lat/lng + city/state
//
// That divergence is exactly what caused the bug:
//   lat/lng update instantly (via "/location") but city/state stay stale
//   (only "/matchmaking-location" ever touched them).
//
// Guarantees enforced here:
//   1. Reverse geocoding ALWAYS happens BEFORE any DB write.
//   2. lat/lng and area/city/state/district/displayName are written together
//      in ONE User.findByIdAndUpdate call — they can never go out of sync.
//   3. If reverse geocoding fails, the previous liveLocation is left
//      completely untouched and the caller gets back a retry signal.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const User = require('../models/User');

// ── Reverse geocoding providers ───────────────────────────────────────────────

/**
 * Primary provider — Nominatim (OpenStreetMap).
 * GET https://nominatim.openstreetmap.org/reverse
 *   ?format=json&addressdetails=1&zoom=18&lat=..&lon=..
 * Throws on failure — never returns partial/guessed data.
 */
async function reverseGeocodeNominatim(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=json&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'HumrahApp/1.0 (contact@humrah.com)' },
  });

  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);

  const data = await response.json();
  if (!data || !data.address) throw new Error('Nominatim returned no address');

  return data.address;
}

/**
 * Fallback provider — BigDataCloud (free, no API key, high reliability).
 * Only used if Nominatim errors or times out.
 */
async function reverseGeocodeBigDataCloud(lat, lng) {
  const url =
    `https://api.bigdatacloud.net/data/reverse-geocode-client` +
    `?latitude=${lat}&longitude=${lng}&localityLanguage=en`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`BigDataCloud HTTP ${response.status}`);

  const data = await response.json();

  // Normalize to look like a Nominatim `address` object so extractAddressFields()
  // can stay provider-agnostic.
  return {
    neighbourhood: data.locality || null,
    suburb:        data.locality || null,
    city:          data.city || data.locality || null,
    city_district: data.locality || null,
    state:         data.principalSubdivision || null,
    country:       data.countryName || null,
  };
}

/**
 * Reverse geocode with automatic fallback.
 * Returns the raw address object, or null if BOTH providers fail — callers
 * MUST treat a null result as a hard failure and never write partial data.
 */
async function reverseGeocode(lat, lng) {
  try {
    return await reverseGeocodeNominatim(lat, lng);
  } catch (e) {
    console.error('[LiveLocation] Nominatim failed:', e.message);
  }
  try {
    return await reverseGeocodeBigDataCloud(lat, lng);
  } catch (e) {
    console.error('[LiveLocation] BigDataCloud fallback failed:', e.message);
  }
  return null;
}

// ── Field extraction (exact Humrah spec) ──────────────────────────────────────
//   area:     neighbourhood || suburb || quarter || road
//   city:     city || town || municipality || county || state_district
//   state:    state
//   district: city_district || county
function extractAddressFields(addr) {
  const area = addr.neighbourhood || addr.suburb || addr.quarter || addr.road || null;

  const city =
    addr.city || addr.town || addr.municipality || addr.county || addr.state_district || null;

  const state = addr.state || null;

  const district = addr.city_district || addr.county || null;

  const country = addr.country || null;

  // displayName = area + ", " + city  (with graceful fallback when one is missing)
  let displayName;
  if (area && city)   displayName = `${area}, ${city}`;
  else if (city)       displayName = city;
  else if (area)       displayName = area;
  else if (state)      displayName = state;
  else                 displayName = null;

  return { area, city, state, district, country, displayName };
}

// ── The atomic update ─────────────────────────────────────────────────────────
/**
 * Atomically update a user's live location.
 *
 * Flow (never deviates, never partially applies):
 *   1. Reverse geocode the coordinates FIRST — before touching the DB at all.
 *   2. If geocoding fails → return { success:false, retry:true } and leave the
 *      user's existing liveLocation (city/state/displayName) completely untouched.
 *   3. If geocoding succeeds → ONE findByIdAndUpdate call writes lat/lng AND
 *      area/city/state/district/displayName together. They can never diverge.
 *
 * @param {string} userId
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{success:boolean, retry?:boolean, liveLocation?:object, message:string}>}
 */
async function updateUserLiveLocation(userId, lat, lng) {
  lat = Number(lat);
  lng = Number(lng);

  if (
    Number.isNaN(lat) || Number.isNaN(lng) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    return { success: false, retry: false, message: 'Invalid coordinates.' };
  }

  // ── STEP 1 — reverse geocode FIRST. No DB write happens before this resolves. ──
  const addr = await reverseGeocode(lat, lng);

  if (!addr) {
    // ── STEP 2 — geocoding failed for both providers.
    // Do NOT overwrite lat/lng, city, or state. Keep whatever was there before,
    // and tell the caller to retry.
    console.warn(
      `[LiveLocation] Reverse geocode failed for user ${userId} @ (${lat}, ${lng}). Previous location preserved.`
    );
    const existing = await User.findById(userId).select('liveLocation').lean();
    return {
      success:      false,
      retry:        true,
      message:      'Reverse geocoding failed. Please try again.',
      liveLocation: existing?.liveLocation || null,
    };
  }

  const { area, city, state, district, country, displayName } = extractAddressFields(addr);
  const now = new Date();

  // ── STEP 3 — single atomic write. lat/lng and city/state land together or not at all. ──
  const updated = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        liveLocation: {
          type:        'Point',
          coordinates: [lng, lat],
          lat,
          lng,
          area,
          district,
          city,
          state,
          country,
          displayName,
          updatedAt: now,
        },
        last_known_lat:           lat,
        last_known_lng:           lng,
        last_location_updated_at: now,
      },
    },
    { new: true, select: 'liveLocation' }
  );

  if (!updated) {
    return { success: false, retry: false, message: 'User not found.' };
  }

  console.log('LOCATION UPDATED:', lat, lng, displayName);

  return {
    success:      true,
    liveLocation: updated.liveLocation,
    message:      'Live location updated successfully.',
  };
}

module.exports = {
  updateUserLiveLocation,
  reverseGeocode,
  extractAddressFields,
};
