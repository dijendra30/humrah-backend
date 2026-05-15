// routes/matchingMood.js
// Mounted in server.js as: app.use('/api/matching-mood', authenticate, enforceLegalAcceptance, matchingMoodRoutes)
// authenticate + enforceLegalAcceptance already applied — do NOT add them here again.
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/matchingMoodController');

// POST /api/matching-mood/app-open   — resolve nearby cache on app open
router.post('/app-open', ctrl.appOpen);

// PUT  /api/matching-mood/go-live    — set mood + visibility (no nearby fetch)
router.put('/go-live', ctrl.goLive);

// PUT  /api/matching-mood/go-offline — hide from feed
router.put('/go-offline', ctrl.goOffline);

// GET  /api/matching-mood/state      — current mood state only
router.get('/state', ctrl.getState);

module.exports = router;
