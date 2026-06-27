const express = require('express');
const router = express.Router();
const homeController = require('../controllers/home.controller');

// GET /api/home/nearby
router.get('/nearby', homeController.getNearbyUsers);

module.exports = router;
