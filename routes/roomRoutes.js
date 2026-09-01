const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');
const { authenticate } = require('../middleware/auth');

router.post('/', authenticate, roomController.createRoom);
router.post('/discover', authenticate, roomController.discoverRooms);
router.post('/:roomId/join', authenticate, roomController.joinRoom);
router.get('/', authenticate, roomController.getMyRooms);
router.get('/:roomId', authenticate, roomController.getRoomDetails);
router.get('/:roomId/messages', authenticate, roomController.getRoomMessages);

module.exports = router;
