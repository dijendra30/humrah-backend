'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/notificationController');

router.get('/', ctrl.getNotifications);
router.get('/unread-count', ctrl.getUnreadCount);
router.get('/:id', ctrl.getNotification);
router.post('/read-all', ctrl.markAllAsRead);
router.post('/:id/read', ctrl.markAsRead);

module.exports = router;
