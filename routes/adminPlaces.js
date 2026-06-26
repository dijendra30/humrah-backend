const express = require('express');
const router = express.Router();
const axios = require('axios');

// Simple In-Memory Cache
const autocompleteCache = new Map(); // 5 minutes TTL
const detailsCache = new Map();      // 24 hours TTL

const AUTOCOMPLETE_TTL = 5 * 60 * 1000;
const DETAILS_TTL = 24 * 60 * 60 * 1000;

function getFromCache(cache, key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setToCache(cache, key, data, ttl) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

// GET /api/admin/places/autocomplete?q=
router.get('/autocomplete', async (req, res) => {
  try {
    const query = req.query.q?.trim();
    console.log("[Places Autocomplete] Query:", query);
    
    if (!query) return res.json({ predictions: [] });

    const cacheKey = query.toLowerCase();
    const cached = getFromCache(autocompleteCache, cacheKey);
    if (cached) return res.json(cached);

    const GOOGLE_API_KEY = process.env.ADMIN_PLACE_API;
    console.log("[Places Autocomplete] API key exists:", !!GOOGLE_API_KEY);
    
    if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Google API key not configured' });

    const url = `https://places.googleapis.com/v1/places:autocomplete`;
    const response = await axios.post(url, {
      input: query,
      includedRegionCodes: ["in"]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_API_KEY
      }
    });

    const suggestions = response.data.suggestions || [];
    const predictions = suggestions.map(s => ({
      placeId: s.placePrediction?.placeId,
      description: s.placePrediction?.text?.text
    })).filter(p => p.placeId);

    const resultPayload = { predictions };
    setToCache(autocompleteCache, cacheKey, resultPayload, AUTOCOMPLETE_TTL);
    res.json(resultPayload);
  } catch (error) {
    console.error("[Places Autocomplete]", error.response?.data || error);
    res.status(500).json({ error: 'Failed to fetch places autocomplete' });
  }
});

// GET /api/admin/places/details?placeId=
router.get('/details', async (req, res) => {
  try {
    const { placeId } = req.query;
    if (!placeId) return res.status(400).json({ error: 'placeId is required' });

    const cached = getFromCache(detailsCache, placeId);
    if (cached) return res.json(cached);

    const GOOGLE_API_KEY = process.env.ADMIN_PLACE_API;
    console.log("[Place Details] API key exists:", !!GOOGLE_API_KEY);
    if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Google API key not configured' });

    const url = `https://places.googleapis.com/v1/places/${placeId}`;
    const response = await axios.get(url, {
      headers: {
        'X-Goog-Api-Key': GOOGLE_API_KEY,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,addressComponents,location'
      }
    });

    const result = response.data;
    if (!result || !result.id) return res.status(404).json({ error: 'Place not found' });

    const lat = result.location?.latitude || 0;
    const lng = result.location?.longitude || 0;

    let city = '';
    let district = '';
    let state = '';
    let country = '';
    let pincode = '';

    (result.addressComponents || []).forEach(c => {
      const val = c.longText;
      const types = c.types || [];
      if (types.includes('locality')) city = val;
      if ((types.includes('administrative_area_level_2') || types.includes('sublocality_level_1')) && !district) district = val;
      if (types.includes('administrative_area_level_1')) state = val;
      if (types.includes('country')) country = val;
      if (types.includes('postal_code')) pincode = val;
    });

    const details = {
      placeId: result.id,
      venueName: result.displayName?.text || '',
      formattedAddress: result.formattedAddress || '',
      city,
      district,
      state,
      country,
      pincode,
      latitude: lat,
      longitude: lng,
      coordinates: [lng, lat]
    };

    setToCache(detailsCache, placeId, details, DETAILS_TTL);
    res.json(details);
  } catch (error) {
    console.error("[Place Details]", error.response?.data || error);
    res.status(500).json({ error: 'Failed to fetch place details' });
  }
});

module.exports = router;
