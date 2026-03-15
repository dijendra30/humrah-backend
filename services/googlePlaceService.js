// services/googlePlaceService.js
// Fetches place details from Google Places API (New / v1).
// Called once at food post creation time — result stored in DB.
// Never called again for the same post.

const https = require('https');

/**
 * Fetch place details from Places API v1.
 *
 * Returns:
 *   { placeName, rating, userRatingCount, latitude, longitude }
 *
 * All fields are null-safe — if the API is unavailable or the key
 * is missing, the function resolves with nulls rather than throwing.
 *
 * @param {string} placeId  Google Place ID (e.g. "ChIJ...")
 * @returns {Promise<{placeName:string|null, rating:number|null, userRatingCount:number|null, latitude:number|null, longitude:number|null}>}
 */
async function getPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
    || process.env.PLACES_API_KEY
    || process.env.GOOGLE_MAPS_API_KEY
    || '';

  const empty = { placeName: null, rating: null, userRatingCount: null, latitude: null, longitude: null };

  if (!apiKey || !placeId) {
    console.warn('⚠️  [Places] No API key — place details will be null. Set GOOGLE_PLACES_API_KEY in env.');
    return empty;
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'places.googleapis.com',
      path:     `/v1/places/${encodeURIComponent(placeId)}`,
      method:   'GET',
      headers:  {
        'X-Goog-Api-Key':   apiKey,
        // ✅ Request only the fields we need — minimises billing cost
        'X-Goog-FieldMask': 'displayName,rating,userRatingCount,location',
        'Content-Type':     'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);

          if (json.error) {
            console.error('❌ [Places] API error:', json.error.message || JSON.stringify(json.error));
            resolve(empty);
            return;
          }

          const placeName      = json.displayName?.text || null;
          const rating         = typeof json.rating === 'number'         ? json.rating         : null;
          const userRatingCount= typeof json.userRatingCount === 'number' ? json.userRatingCount : null;
          const latitude       = typeof json.location?.latitude  === 'number' ? json.location.latitude  : null;
          const longitude      = typeof json.location?.longitude === 'number' ? json.location.longitude : null;

          console.log(`⭐ [Places] ${placeId} → ${placeName} | rating=${rating} | reviews=${userRatingCount}`);

          resolve({ placeName, rating, userRatingCount, latitude, longitude });
        } catch (e) {
          console.error('❌ [Places] Parse error:', e.message, '| body:', body.slice(0, 200));
          resolve(empty);
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ [Places] Request error:', e.message);
      resolve(empty);
    });

    req.end();
  });
}

module.exports = { getPlaceDetails };
