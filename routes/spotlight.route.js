// routes/spotlight.route.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const {
  getSpotlightCompanions
} = require('../controllers/spotlight.controller');

// GET /api/spotlight
// Fetch personalized companion recommendations based on shared hangout preferences
router.get('/', protect, getSpotlightCompanions);

module.exports = router;
