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

router.post  ('/create',       ctrl.createActivity);    // POST /api/activity/create
router.get   ('/unread-count', ctrl.getUnreadCount);    // GET  /api/activity/unread-count  ← badge fetch
router.get   ('/',             ctrl.getActivities);     // GET  /api/activity
router.patch ('/read/:id',     ctrl.markRead);          // PATCH /api/activity/read/:id
router.patch ('/read-all',     ctrl.markAllRead);       // PATCH /api/activity/read-all

module.exports = router;
