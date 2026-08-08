const express = require('express');
const router = express.Router();
const appConfigController = require('../controllers/appConfig.controller');

// Public endpoint, no authentication required
router.get('/', appConfigController.getAppConfig);

module.exports = router;
