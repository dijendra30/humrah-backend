// routes/spotlight.route.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const spotlightController = require('../controllers/spotlight.controller');

// ✅ Debug: Check if controller loaded correctly
console.log('Spotlight controller loaded:', {
  controllerExists: !!spotlightController,
  getSpotlightCompanions: typeof spotlightController.getSpotlightCompanions
});

// GET /api/spotlight
router.get('/', auth, spotlightController.getSpotlightCompanions);

module.exports = router;
