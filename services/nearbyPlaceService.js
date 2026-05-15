// services/nearbyPlaceService.js
// Fetches nearby places from Overpass API (OpenStreetMap).
// Called ONLY on app open — never on mood click / bottom sheet / Go Live.
// Results cached per locationHash in MatchingTodayMood.nearbyData.
'use strict';

const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Cache valid for 12 hours (in ms). After this, re-fetch on next app open.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// Radius (metres) for Overpass search around user's location
const SEARCH_RADIUS_M = 1200;

// Max places to return in the names list
const MAX_PLACE_NAMES = 3;

// Overpass tags that count as "nearby activity places"
const OVERPASS_FILTERS = `
  node["amenity"~"cafe|restaurant|bar|fast_food|food_court|pub"](around:RADIUS,LAT,LNG);
  node["leisure"~"fitness_centre|sports_centre|park|pitch"](around:RADIUS,LAT,LNG);
  node["shop"~"mall|supermarket|convenience"](around:RADIUS,LAT,LNG);
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// LOCATION HASH UTIL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a 2-decimal-place grid key from lat/lng.
 * ~1.1 km cell size. Same area = same hash = shared cache.
 * @param {number} lat
 * @param {number} lng
 * @returns {string}  e.g. "28.70_77.10"
 */
function toLocationHash(lat, lng) {
  const rLat = Math.round(lat * 100) / 100;
  const rLng = Math.round(lng * 100) / 100;
  return `${rLat.toFixed(2)}_${rLng.toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OVERPASS FETCH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch nearby place count + top names from Overpass API.
 * Returns { count, places } on success, { count: 0, places: [] } on failure.
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{count:number, places:string[]}>}
 */
async function fetchNearbyFromOverpass(lat, lng) {
  const query = `
    [out:json][timeout:10];
    (
      ${OVERPASS_FILTERS
        .replace(/LAT/g, lat)
        .replace(/LNG/g, lng)
        .replace(/RADIUS/g, SEARCH_RADIUS_M)}
    );
    out body ${MAX_PLACE_NAMES + 20};
  `.trim();

  return new Promise((resolve) => {
    const body = `data=${encodeURIComponent(query)}`;
    const options = {
      hostname: 'overpass-api.de',
      path:     '/api/interpreter',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Humrah-App/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const elements = json.elements || [];

          const count = elements.length;

          // Extract named places, deduplicated, max MAX_PLACE_NAMES
          const seen = new Set();
          const places = [];
          for (const el of elements) {
            const name = el.tags?.name;
            if (name && !seen.has(name)) {
              seen.add(name);
              places.push(name);
              if (places.length >= MAX_PLACE_NAMES) break;
            }
          }

          console.log(`📍 [Nearby] ${lat},${lng} → ${count} places, top: ${places.join(', ') || 'none'}`);
          resolve({ count, places });
        } catch (e) {
          console.error('❌ [Nearby] Parse error:', e.message);
          resolve({ count: 0, places: [] });
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ [Nearby] Request error:', e.message);
      resolve({ count: 0, places: [] });
    });

    req.setTimeout(12000, () => {
      console.warn('⚠️ [Nearby] Overpass timeout');
      req.destroy();
      resolve({ count: 0, places: [] });
    });

    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — used by matchingMoodController on app open
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get nearby data for a user's location.
 * Uses MatchingTodayMood.nearbyData as cache.
 * Re-fetches if missing, stale (> CACHE_TTL_MS), or locationHash changed.
 *
 * @param {Object} moodDoc    Mongoose doc from MatchingTodayMood
 * @param {number} lat
 * @param {number} lng
 * @param {string} locationHash
 * @returns {Promise<{count:number, places:string[], fromCache:boolean}>}
 */
async function resolveNearbyData(moodDoc, lat, lng, locationHash) {
  const now = Date.now();
  const cacheAge = moodDoc.updatedAt ? now - moodDoc.updatedAt.getTime() : Infinity;
  const hashChanged = moodDoc.locationHash !== locationHash;
  const hasData = moodDoc.nearbyData?.count > 0;

  // Use cache if: same area, still fresh, has data
  if (hasData && !hashChanged && cacheAge < CACHE_TTL_MS) {
    console.log(`⚡ [Nearby] Cache hit — locationHash=${locationHash}`);
    return { ...moodDoc.nearbyData.toObject(), fromCache: true };
  }

  // Re-fetch
  console.log(`🔄 [Nearby] Cache miss — fetching Overpass (hash=${locationHash}, hashChanged=${hashChanged})`);
  const fresh = await fetchNearbyFromOverpass(lat, lng);
  return { ...fresh, fromCache: false };
}

module.exports = { toLocationHash, resolveNearbyData, fetchNearbyFromOverpass };
