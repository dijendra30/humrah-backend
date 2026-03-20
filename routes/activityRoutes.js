// routes/activityRoutes.js
// Registered in server.js as:
//   app.use('/api/activity', authenticate, enforceLegalAcceptance, activityRoutes);
//
// Endpoints:
//   GET    /api/activity              — paginated feed for current user
//   PATCH  /api/activity/read/:id     — mark single item as read
//   PATCH  /api/activity/read-all     — mark all items as read

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/activityController');

router.get   ('/',          ctrl.getActivities);
router.patch ('/read/:id',  ctrl.markRead);
router.patch ('/read-all',  ctrl.markAllRead);

module.exports = router;
