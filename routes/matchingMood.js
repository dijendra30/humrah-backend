// routes/matchingMood.js
'use strict';

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/matchingMoodController');

// POST /api/matching-mood/app-open   → resolve location + nearby cache
router.post('/app-open', authenticate, ctrl.appOpen);

// PUT  /api/matching-mood/go-live    → set mood visible
router.put('/go-live', authenticate, ctrl.goLive);

// PUT  /api/matching-mood/go-offline → hide from feed
router.put('/go-offline', authenticate, ctrl.goOffline);

// GET  /api/matching-mood/state      → current mood + nearbyData
router.get('/state', authenticate, ctrl.getState);

module.exports = router;
