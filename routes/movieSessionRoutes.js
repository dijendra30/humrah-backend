// routes/movieSessionRoutes.js
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/movieSessionController');

// ── Movies ────────────────────────────────────────────────────────────────────
// GET /api/movies
// Trending India movies from TMDB (cached 15 min)
router.get('/movies', ctrl.getMovies);

// ── Theatres ──────────────────────────────────────────────────────────────────
// GET /api/theatres?lat=&lng=&radius=
// Top 5 nearby cinemas, rating >= 3.0, sorted by distance+rating
router.get('/theatres', ctrl.getNearbyTheatres);

// GET /api/theatres/search?q=&lat=&lng=
// Full-text search — separate section in UI ("Search Results"), not mixed with Nearby
// lat/lng are optional (used to bias results, not to enforce distance)
router.get('/theatres/search', ctrl.searchTheatres);

// ── Sessions ──────────────────────────────────────────────────────────────────
// GET /api/movie-session/debug  ← TEMPORARY, remove in prod
router.get('/movie-session/debug', ctrl.debugSessions);

// GET /api/movie-session/my — sessions the current user joined/created
router.get('/movie-session/my', ctrl.getMySessions);

// GET /api/movie-session/suggestion?movieId=&lat=&lng=
// Checks if a nearby session for the same movie exists (create-flow suggestion)
router.get('/movie-session/suggestion', ctrl.getSuggestion);

// GET /api/movie-session/nearby?lat=&lng=
// 4-step flow: fetch → generate if sparse → re-fetch → sort → top 5
router.get('/movie-session/nearby', ctrl.getNearbySessions);

// POST /api/movie-session/create
router.post('/movie-session/create', ctrl.createSession);

// POST /api/movie-session/:id/join
router.post('/movie-session/:id/join', ctrl.joinSession);

// GET /api/movie-session/:id/chat
router.get('/movie-session/:id/chat', ctrl.getSessionChat);

// POST /api/movie-session/:id/chat/message
router.post('/movie-session/:id/chat/message', ctrl.sendMessage);

module.exports = router;
