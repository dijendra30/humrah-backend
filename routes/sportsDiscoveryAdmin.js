// routes/sportsDiscoveryAdmin.js
// -----------------------------------------------------------------------------
// Sports discovery (Phase 5D): ONE read-only status route for operators.
//
//   GET /api/admin/sports-discovery/status          gate, breaker, last tick, indexes, delivery counts
//   GET /api/admin/sports-discovery/status?deep=1   plus bounded counts over the users collection
//
// Mounted in server.js behind `authenticate` and `superAdminOnly`. It can only READ:
// no other verb exists, it cannot enable, disable, send, or change anything, and it takes
// no input beyond the `deep` flag. The feature is switched on and off only through the
// environment (SPORTS_DISCOVERY_ENABLED / SPORTS_DISCOVERY_STARTED_AT), never through the API.
//
// server.js turns any unhandled promise rejection into a shutdown of the whole server, so
// this handler catches EVERYTHING and answers with a generic error.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const deep = req.query.deep === '1';
    const status = await require('../services/sportsDiscoveryService').getStatus({ deep });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...status });
  } catch (err) {
    console.error(`[SPORTS_DISCOVERY] status failed: ${(err && err.name) || 'Error'}`);
    return res.status(500).json({ success: false, message: 'Status is unavailable right now.' });
  }
});

module.exports = router;
