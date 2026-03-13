// routes/moderation_route.js
const express    = require('express');
const router     = express.Router();
const { auth }   = require('../middleware/auth');
const ctrl       = require('../controllers/moderation_controller');

// All routes require authentication (auth middleware already applied
// globally in server.js, but added here too for explicitness/safety)

// POST /api/moderation/report-user
router.post('/report-user', auth, ctrl.reportUser);

// POST /api/moderation/block-user
router.post('/block-user', auth, ctrl.blockUser);

// DELETE /api/moderation/unblock-user
router.delete('/unblock-user', auth, ctrl.unblockUser);

module.exports = router;
