// routes/movieSessionRoutes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/movieSessionController');

// GET /api/movies          – trending India movies (TMDB, cached 15 min)
router.get('/movies', ctrl.getMovies);

// GET /api/theatres        – nearby cinemas (Google Places)
router.get('/theatres', ctrl.getNearbyTheatres);

// POST /api/movie-session/create
router.post('/movie-session/create', ctrl.createSession);

// GET  /api/movie-session/debug   ← temporary, remove after confirming flow
router.get('/movie-session/debug', ctrl.debugSessions);

// GET  /api/movie-session/nearby
router.get('/movie-session/nearby', ctrl.getNearbySessions);

// POST /api/movie-session/:id/join
router.post('/movie-session/:id/join', ctrl.joinSession);

// GET  /api/movie-session/:id/chat
router.get('/movie-session/:id/chat', ctrl.getSessionChat);

// POST /api/movie-session/:id/chat/message
router.post('/movie-session/:id/chat/message', ctrl.sendMessage);

module.exports = router;
