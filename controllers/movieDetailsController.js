// controllers/movieDetailsController.js
// ─────────────────────────────────────────────────────────────────────────────
// THIN HTTP ADAPTER for GET /api/movies/:movieId/details.
// All logic lives in services/tmdbMovieDetailsService.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const svc = require('../services/tmdbMovieDetailsService');

// Same contract as movieSessionController's send(): `status` becomes the HTTP code.
function send(res, result) {
  const code = result.status || (result.success ? 200 : 400);
  delete result.status;
  return res.status(code).json(result);
}

// =============================================================================
// GET /api/movies/:movieId/details   (movieId = the TMDB movie ID)
// =============================================================================
exports.getMovieDetails = async (req, res) => {
  try {
    return send(res, await svc.getMovieDetails(req.params.movieId));
  } catch (err) {
    console.error('[ctrl] getMovieDetails:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
