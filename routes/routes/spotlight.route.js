// routes/spotlight.route.js - Simple routing (delegates to controller)
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const spotlightController = require('../controllers/spotlight.controller');

// GET /api/spotlight - Get spotlight companions
router.get('/', auth, spotlightController.getSpotlightCompanions);

module.exports = router;
