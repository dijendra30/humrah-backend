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
    if (!query) return res.json([]);

    const cacheKey = query.toLowerCase();
    const cached = getFromCache(autocompleteCache, cacheKey);
    if (cached) return res.json(cached);

    const apiKey = process.env.ADMIN_PLACE_API || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Google API key not configured' });

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json`;
    const response = await axios.get(url, {
      params: {
        input: query,
        key: apiKey,
        components: 'country:in',
        types: 'establishment|geocode'
      }
    });

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      console.error('Google Places API Error:', response.data.status, response.data.error_message);
      return res.status(500).json({ error: response.data.error_message || 'Google API Error' });
    }

    const results = (response.data.predictions || []).map(p => ({
      placeId: p.place_id,
      description: p.description
    }));

    setToCache(autocompleteCache, cacheKey, results, AUTOCOMPLETE_TTL);
    res.json(results);
  } catch (error) {
    console.error('Places Autocomplete Error:', error.message);
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

    const apiKey = process.env.ADMIN_PLACE_API || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Google API key not configured' });

    const url = `https://maps.googleapis.com/maps/api/place/details/json`;
    const response = await axios.get(url, {
      params: {
        place_id: placeId,
        key: apiKey,
        fields: 'name,formatted_address,geometry,address_components'
      }
    });

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      console.error('Google Places API Error:', response.data.status, response.data.error_message);
      return res.status(500).json({ error: response.data.error_message || 'Google API Error' });
    }

    const result = response.data.result;
    if (!result) return res.status(404).json({ error: 'Place not found' });

    const lat = result.geometry?.location?.lat || 0;
    const lng = result.geometry?.location?.lng || 0;

    let city = '';
    let district = '';
    let state = '';
    let country = '';
    let pincode = '';

    (result.address_components || []).forEach(c => {
      if (c.types.includes('locality')) city = c.long_name;
      if (c.types.includes('sublocality_level_1') && !district) district = c.long_name;
      if (c.types.includes('administrative_area_level_1')) state = c.long_name;
      if (c.types.includes('country')) country = c.long_name;
      if (c.types.includes('postal_code')) pincode = c.long_name;
    });

    const details = {
      placeId,
      venueName: result.name,
      formattedAddress: result.formatted_address,
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
    console.error('Places Details Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch place details' });
  }
});

module.exports = router;
