// routes/moderation_route.js
// Handles user-facing report + block actions (NOT admin moderation panel)
// Registered in server.js as separate paths to avoid collision with
// the existing admin-only /api/moderation route.
//
// Add these TWO lines to server.js (after existing route registrations):
//
//   const userModerationRoutes = require('./routes/moderation_route');
//   app.use('/api', authenticate, enforceLegalAcceptance, userModerationRoutes);
//
// This mounts:
//   POST   /api/report-user
//   POST   /api/block-user
//   DELETE /api/unblock-user

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/moderation_controller');

// POST /api/report-user
router.post('/report-user', ctrl.reportUser);

// POST /api/block-user
router.post('/block-user', ctrl.blockUser);

// DELETE /api/unblock-user
router.delete('/unblock-user', ctrl.unblockUser);

module.exports = router;
