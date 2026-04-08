// controllers/movieSessionController.js
// ─────────────────────────────────────────────────────────────────────────────
// THIN HTTP ADAPTER. Zero business logic here.
// All logic lives in services/movieSessionService.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const svc = require('../services/movieSessionService');

// ─── Helper: get userId from req ─────────────────────────────────────────────
const uid = req => (req.user?.id || req.user?._id || req.userId)?.toString();

// ─── Helper: send service result as HTTP response ────────────────────────────
function send(res, result) {
  const code = result.status || (result.success ? 200 : 400);
  delete result.status;
  return res.status(code).json(result);
}

// =============================================================================
// GET /api/movies
// =============================================================================
exports.getMovies = async (req, res) => {
  try {
    return send(res, await svc.getMovies());
  } catch (err) {
    console.error('[ctrl] getMovies:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/theatres?lat=&lng=&radius=
// Returns top 5 nearby cinemas, rating >= 3.0
// lat/lng optional — service falls back to user's DB-stored location
// =============================================================================
exports.getNearbyTheatres = async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;
    return send(res, await svc.getNearbyTheatres(uid(req), lat, lng, radius));
  } catch (err) {
    console.error('[ctrl] getNearbyTheatres:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/theatres/search?q=&lat=&lng=
// Full-text search via Google Places — ignores distance limit
// Returns up to 10 results in separate 'Search Results' section (not mixed with Nearby)
// =============================================================================
exports.searchTheatres = async (req, res) => {
  try {
    const { q, lat, lng } = req.query;
    const pLat = lat ? parseFloat(lat) : null;
    const pLng = lng ? parseFloat(lng) : null;
    return send(res, await svc.searchTheatres(q, pLat, pLng));
  } catch (err) {
    console.error('[ctrl] searchTheatres:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/nearby?lat=&lng=
// STRICT FLOW: fetch → generate if < 2 → re-fetch → sort → top 5
// =============================================================================
exports.getNearbySessions = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    return send(res, await svc.getNearbySessions(uid(req), lat, lng));
  } catch (err) {
    console.error('[ctrl] getNearbySessions:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// POST /api/movie-session/create
// Language is fetched from user profile — never accepted from frontend
// =============================================================================
exports.createSession = async (req, res) => {
  try {
    return send(res, await svc.createSession(uid(req), req.body));
  } catch (err) {
    console.error('[ctrl] createSession:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// POST /api/movie-session/:id/join
// Atomic admin assignment + chat message
// =============================================================================
exports.joinSession = async (req, res) => {
  try {
    const io = req.app.get('io');
    return send(res, await svc.joinSession(uid(req), req.params.id, io));
  } catch (err) {
    console.error('[ctrl] joinSession:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/:id/chat
// =============================================================================
exports.getSessionChat = async (req, res) => {
  try {
    return send(res, await svc.getSessionChat(uid(req), req.params.id));
  } catch (err) {
    console.error('[ctrl] getSessionChat:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// POST /api/movie-session/:id/chat/message
// =============================================================================
exports.sendMessage = async (req, res) => {
  try {
    const io = req.app.get('io');
    return send(res, await svc.sendMessage(uid(req), req.params.id, req.body.text, io));
  } catch (err) {
    console.error('[ctrl] sendMessage:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/suggestion?movieId=&lat=&lng=
// Called when user selects a movie in the create flow.
// Returns at most ONE nearby session for the same movie (2 hrs + 15 km window).
// Response: { suggestion: {...} } or { suggestion: null }
// =============================================================================
exports.getSuggestion = async (req, res) => {
  try {
    const { movieId, lat, lng } = req.query;
    return send(res, await svc.getSuggestionForMovie(uid(req), movieId, lat, lng));
  } catch (err) {
    console.error('[ctrl] getSuggestion:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/my
// Sessions the user is a participant in — for Messages → Sessions tab
// =============================================================================
exports.getMySessions = async (req, res) => {
  try {
    return send(res, await svc.getMySessions(uid(req)));
  } catch (err) {
    console.error('[ctrl] getMySessions:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/debug  ← TEMPORARY — remove after confirming data flow
// =============================================================================
exports.debugSessions = async (req, res) => {
  try {
    return res.json(await svc.debugSessions());
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
