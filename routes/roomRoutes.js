const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');
const { authenticate } = require('../middleware/auth');
const {
  validateRoomId,
  roomCreateLimiter,
  roomJoinLimiter,
  roomReactionLimiter,
} = require('../middleware/roomGuards');

router.post('/', authenticate, roomCreateLimiter, roomController.createRoom);
router.get('/topics', authenticate, roomController.getTopics);
router.post('/discover', authenticate, roomController.discoverRooms);
router.get('/', authenticate, roomController.getMyRooms);

// All :roomId routes validate the id shape first (malformed -> 400, not 500).
router.post('/:roomId/join', authenticate, validateRoomId, roomJoinLimiter, roomController.joinRoom);
router.post('/:roomId/leave', authenticate, validateRoomId, roomController.leaveRoom);
router.get('/:roomId', authenticate, validateRoomId, roomController.getRoomDetails);
router.get('/:roomId/messages', authenticate, validateRoomId, roomController.getRoomMessages);

// Phase 2.1 — server-authoritative read state (JOINED members only).
router.post('/:roomId/read', authenticate, validateRoomId, roomController.markRoomRead);

// Phase 2.1 — message reactions. POST adds/changes, DELETE removes.
router.post(
  '/:roomId/messages/:messageId/reaction',
  authenticate, validateRoomId, roomReactionLimiter, roomController.addRoomMessageReaction
);
router.delete(
  '/:roomId/messages/:messageId/reaction',
  authenticate, validateRoomId, roomReactionLimiter, roomController.removeRoomMessageReaction
);

module.exports = router;
