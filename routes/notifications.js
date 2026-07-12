'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/notificationController');

router.get('/', ctrl.getNotifications);
router.post('/', ctrl.restoreNotification);
router.get('/unread-count', ctrl.getUnreadCount);
router.get('/:id', ctrl.getNotification);
router.post('/read-all', ctrl.markAllAsRead);
router.post('/broadcast/:id/click', ctrl.markBroadcastAsClicked);
router.post('/:id/read', ctrl.markAsRead);
router.post('/:id/click', ctrl.markAsClicked);
router.delete('/:id', ctrl.deleteNotification);
router.delete('/', ctrl.deleteAllNotifications);

module.exports = router;
