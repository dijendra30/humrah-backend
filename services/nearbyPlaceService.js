// services/nearbyPlaceService.js
// Area-based shared cache using NearbyAreaCache collection.
// All users in the same grid cell share one cached result.
'use strict';

const https          = require('https');
const NearbyAreaCache = require('../models/NearbyAreaCache');

const SEARCH_RADIUS_M   = 2500;
const FALLBACK_RADIUS_M = 5000;
const MIN_RESULTS       = 3;
const MAX_PER_CATEGORY  = 5;
const CACHE_TTL_MS      = 12 * 60 * 60 * 1000; // 12 h

// ── locationHash ──────────────────────────────────────────────────────────────
function toLocationHash(lat, lng) {
  return `${(Math.round(lat * 100) / 100).toFixed(2)}_${(Math.round(lng * 100) / 100).toFixed(2)}`;
}

// ── Category classifier ───────────────────────────────────────────────────────
function classifyElement(tags) {
  if (!tags) return null;
  const { amenity = '', leisure = '', tourism = '', shop = '', historic = '' } = tags;
  if (/cafe|coffee_shop/i.test(amenity))                     return 'cafe';
  if (/restaurant|fast_food|food_court/i.test(amenity))      return 'food';
  if (/park|garden/i.test(leisure))                          return 'walk';
  if (/library|college|university/i.test(amenity))           return 'study';
  if (/fitness_centre|sports_centre|stadium/i.test(leisure)) return 'fitness';
  if (/gym/i.test(amenity))                                  return 'fitness';
  if (/attraction|viewpoint|museum/i.test(tourism))          return 'explore';
  if (historic)                                              return 'explore';
  if (/marketplace|arts_centre/i.test(amenity))              return 'explore';
  if (/mall|supermarket/i.test(shop))                        return 'walk';
  return null;
}

// ── Overpass query builder ────────────────────────────────────────────────────
function buildQuery(lat, lng, radiusM) {
  const c = `${lat},${lng}`;
  const r = radiusM;
  return `[out:json][timeout:15];(`
    + `node["amenity"~"cafe|coffee_shop"](around:${r},${c});`
    + `node["amenity"~"restaurant|fast_food|food_court"](around:${r},${c});`
    + `node["leisure"~"park|garden"](around:${r},${c});`
    + `way["leisure"~"park|garden"](around:${r},${c});`
    + `node["amenity"~"library|college|university"](around:${r},${c});`
    + `node["leisure"~"fitness_centre|sports_centre|stadium"](around:${r},${c});`
    + `node["amenity"="gym"](around:${r},${c});`
    + `node["tourism"~"attraction|viewpoint|museum"](around:${r},${c});`
    + `node["historic"](around:${r},${c});`
    + `node["amenity"="marketplace"](around:${r},${c});`
    + `node["amenity"~"arts_centre"](around:${r},${c});`
    + `node["shop"~"mall|supermarket"](around:${r},${c});`
    + `);out body 150;`;
}

// ── Raw Overpass HTTP request ─────────────────────────────────────────────────
function overpassRequest(query) {
  return new Promise((resolve) => {
    const body = `data=${encodeURIComponent(query)}`;
    const opts = {
      hostname: 'overpass-api.de',
      path:     '/api/interpreter',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Humrah/1.0',
      },
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const elements = JSON.parse(raw).elements || [];
          console.log(`📍 [NearbyCache] Overpass: ${elements.length} elements`);

          const CATS = ['cafe', 'food', 'walk', 'study', 'fitness', 'explore'];
          const counts   = Object.fromEntries(CATS.map(c => [c, 0]));
          const places   = Object.fromEntries(CATS.map(c => [c, []]));
          const seen     = Object.fromEntries(CATS.map(c => [c, new Set()]));
          const gSeen    = new Set();
          const gPlaces  = [];

          for (const el of elements) {
            const tags = el.tags || {};
            const name = tags.name;
            const cat  = classifyElement(tags);

            if (cat) {
              counts[cat]++;
              if (name && !seen[cat].has(name) && places[cat].length < MAX_PER_CATEGORY) {
                seen[cat].add(name);
                places[cat].push(name);
              }
            }
            if (name && !gSeen.has(name) && gPlaces.length < MAX_PER_CATEGORY) {
              gSeen.add(name);
              gPlaces.push(name);
            }
          }

          // Fallback: empty category → global list
          for (const cat of CATS) {
            if (places[cat].length === 0) places[cat] = [...gPlaces];
          }

          resolve({ totalCount: elements.length, counts, places, globalPlaces: gPlaces });
        } catch (e) {
          console.error('❌ [NearbyCache] parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => { console.error('❌ [NearbyCache] error:', e.message); resolve(null); });
    req.setTimeout(18000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Fetch from Overpass with 1 fallback retry ─────────────────────────────────
async function fetchFromOverpass(lat, lng) {
  let result = await overpassRequest(buildQuery(lat, lng, SEARCH_RADIUS_M));
  if (!result || result.totalCount < MIN_RESULTS) {
    console.log(`📍 [NearbyCache] Retrying at ${FALLBACK_RADIUS_M}m`);
    result = await overpassRequest(buildQuery(lat, lng, FALLBACK_RADIUS_M));
  }
  return result;
}

// ── Build empty moods object ──────────────────────────────────────────────────
function emptyMoods() {
  const CATS = ['cafe', 'food', 'walk', 'study', 'fitness', 'explore'];
  return Object.fromEntries(CATS.map(c => [c, { count: 0, places: [] }]));
}

// ── Convert raw Overpass result → moods shape ─────────────────────────────────
function toMoodsShape(result) {
  if (!result) return emptyMoods();
  const CATS = ['cafe', 'food', 'walk', 'study', 'fitness', 'explore'];
  return Object.fromEntries(
    CATS.map(cat => [cat, { count: result.counts[cat] ?? 0, places: result.places[cat] ?? [] }])
  );
}

// ── Write (upsert) area cache ─────────────────────────────────────────────────
async function writeAreaCache(locationHash, result) {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
  const moods     = toMoodsShape(result);

  await NearbyAreaCache.findOneAndUpdate(
    { locationHash },
    { $set: { moods, globalPlaces: result?.globalPlaces ?? [], generatedAt: now, updatedAt: now, expiresAt } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`📍 [NearbyCache] Written cache for ${locationHash}`);
}

// ── PUBLIC: get cache (cache-first, bg-refresh if stale) ─────────────────────
// Returns { moods, globalPlaces, fromCache }
// NEVER blocks on Overpass if stale — refreshes in background.
async function getAreaNearby(lat, lng) {
  const locationHash = toLocationHash(lat, lng);
  const now          = new Date();

  const cached = await NearbyAreaCache.findOne({ locationHash }).lean();

  if (cached && cached.expiresAt > now) {
    // Fresh cache — return immediately
    return { locationHash, moods: cached.moods, globalPlaces: cached.globalPlaces ?? [], fromCache: true };
  }

  if (cached) {
    // Stale cache — return old data NOW, refresh in background
    setImmediate(async () => {
      try {
        const fresh = await fetchFromOverpass(lat, lng);
        await writeAreaCache(locationHash, fresh);
      } catch (e) {
        console.error('❌ [NearbyCache] bg refresh failed:', e.message);
      }
    });
    return { locationHash, moods: cached.moods, globalPlaces: cached.globalPlaces ?? [], fromCache: true, stale: true };
  }

  // No cache — must fetch now (first user in this area)
  const fresh = await fetchFromOverpass(lat, lng);
  await writeAreaCache(locationHash, fresh);
  const moods = toMoodsShape(fresh);
  return { locationHash, moods, globalPlaces: fresh?.globalPlaces ?? [], fromCache: false };
}

// ── Legacy compat shape (nearbyCounts + categoryPlaces) ──────────────────────
// Used by controller to keep response shape compatible with Android client.
function toLegacyShape(moods, globalPlaces) {
  return {
    count:          Object.values(moods).reduce((s, m) => s + (m.count ?? 0), 0),
    places:         globalPlaces,
    nearbyCounts:   Object.fromEntries(Object.entries(moods).map(([k, v]) => [k, v.count ?? 0])),
    categoryPlaces: Object.fromEntries(Object.entries(moods).map(([k, v]) => [k, v.places ?? []])),
  };
}

module.exports = { toLocationHash, getAreaNearby, toLegacyShape, CACHE_TTL_MS };
