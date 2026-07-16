const express = require('express');
const router = express.Router();
const launchRegionController = require('../controllers/launchRegionController');
const { authenticate } = require('../middleware/auth');

router.get('/status', authenticate, launchRegionController.getLaunchRegionStatus);

module.exports = router;
