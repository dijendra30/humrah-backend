const express = require('express');
const router = express.Router();
const homeController = require('../controllers/home.controller');

// GET /api/home/nearby
// Serves the PUBLISHED app. Its `nearbyUsers` array is Companion-only. Unchanged.
router.get('/nearby', homeController.getNearbyUsers);

// GET /api/home/people-nearby
// Additive — serves the new Home's "People Near You" (MEMBERS + COMPANIONS).
// Inherits the same `authenticate` + `enforceLegalAcceptance` middleware as
// /nearby, applied where this router is mounted in server.js.
router.get('/people-nearby', homeController.getPeopleNearby);

module.exports = router;
