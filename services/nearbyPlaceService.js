// services/nearbyPlaceService.js
// Overpass API fetch + locationHash utility.
// Called ONLY from appOpen in matchingMoodController.
// Cache check/write happens in the controller against MatchingTodayMood.
'use strict';

const https = require('https');

const SEARCH_RADIUS_M = 1200;
const MAX_NAMES       = 3;
const CACHE_TTL_MS    = 12 * 60 * 60 * 1000; // 12h

// ── locationHash ─────────────────────────────────────────────────────────────
// 2-decimal rounding → ~1.1km grid cell. Same area = same hash = cache reuse.
function toLocationHash(lat, lng) {
  return `${(Math.round(lat * 100) / 100).toFixed(2)}_${(Math.round(lng * 100) / 100).toFixed(2)}`;
}

// ── Overpass fetch ────────────────────────────────────────────────────────────
// Returns { count, places } — flat list, top named places, all categories.
async function fetchNearbyFromOverpass(lat, lng) {
  const R = SEARCH_RADIUS_M;
  const query = `[out:json][timeout:12];(node["amenity"~"cafe|restaurant|fast_food|bar|pub|nightclub"](around:${R},${lat},${lng});node["leisure"~"fitness_centre|sports_centre|park|garden"](around:${R},${lat},${lng});node["shop"~"mall|supermarket|convenience"](around:${R},${lat},${lng});node["tourism"~"viewpoint|attraction"](around:${R},${lat},${lng}););out body 80;`;

  return new Promise((resolve) => {
    const body = `data=${encodeURIComponent(query)}`;
    const opts = {
      hostname: 'overpass-api.de',
      path:     '/api/interpreter',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Humrah/1.0' },
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const elements = JSON.parse(raw).elements || [];
          const count    = elements.length;
          const seen     = new Set();
          const places   = [];
          for (const el of elements) {
            const name = el.tags?.name;
            if (name && !seen.has(name)) { seen.add(name); places.push(name); }
            if (places.length >= MAX_NAMES) break;
          }
          console.log(`📍 [Nearby] ${lat},${lng} → ${count} places`);
          resolve({ count, places });
        } catch (e) {
          console.error('❌ [Nearby] parse error:', e.message);
          resolve({ count: 0, places: [] });
        }
      });
    });

    req.on('error', (e) => { console.error('❌ [Nearby] request error:', e.message); resolve({ count: 0, places: [] }); });
    req.setTimeout(14000, () => { req.destroy(); resolve({ count: 0, places: [] }); });
    req.write(body);
    req.end();
  });
}

module.exports = { toLocationHash, fetchNearbyFromOverpass, CACHE_TTL_MS };
