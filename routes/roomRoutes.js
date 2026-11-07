const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');
const meetupController = require('../controllers/meetupController');
const { authenticate } = require('../middleware/auth');
const {
  validateRoomId,
  roomCreateLimiter,
  roomJoinLimiter,
  roomReactionLimiter,
  roomDiscoverLimiter,
} = require('../middleware/roomGuards');
const guards = require('../middleware/roomGuards');

router.post('/', authenticate, roomCreateLimiter, roomController.createRoom);
router.get('/topics', authenticate, roomController.getTopics);
router.post('/discover', authenticate, roomDiscoverLimiter, roomController.discoverRooms);
router.get('/', authenticate, roomController.getMyRooms);

// All :roomId routes validate the id shape first (malformed -> 400, not 500).
router.post('/:roomId/join', authenticate, validateRoomId, roomJoinLimiter, roomController.joinRoom);
router.post('/:roomId/leave', authenticate, validateRoomId, roomController.leaveRoom);
router.get('/:roomId', authenticate, validateRoomId, roomController.getRoomDetails);
// Room supply: what a ROOM_RECRUIT notification opens (additive).
router.get('/:roomId/preview', authenticate, validateRoomId, roomController.getRoomPreview);
router.get('/:roomId/messages', authenticate, validateRoomId, roomController.getRoomMessages);

// Phase 3.1 — chat actions and members (JOINED members only; rules in roomChatService).
router.patch('/:roomId/messages/:messageId', authenticate, validateRoomId, guards.roomEditLimiter, roomController.editRoomMessage);
router.delete('/:roomId/messages/:messageId', authenticate, validateRoomId, guards.roomDeleteLimiter, roomController.deleteRoomMessage);
router.post('/:roomId/messages/:messageId/hide', authenticate, validateRoomId, guards.roomHideLimiter, roomController.hideRoomMessage);
router.post('/:roomId/messages/:messageId/link-check', authenticate, validateRoomId, guards.roomLinkLimiter, roomController.checkRoomMessageLink);
router.get('/:roomId/members', authenticate, validateRoomId, guards.roomMembersLimiter, roomController.getRoomMembers);
router.post('/:roomId/members/:userId/remove', authenticate, validateRoomId, guards.roomRemoveLimiter, roomController.removeRoomMember);

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

// R7.1 — Meetup proposal. Self-gated by MEETUP_ENABLED (default false), which the
// proposal service checks before any database access, so mounting this route
// changes nothing in production. Reuses validateRoomId; the per-user proposal
// quota is enforced inside the service (rolling window, fails closed) rather than
// by a middleware limiter, because it must only charge successful proposals.
router.post('/:roomId/meetups', authenticate, validateRoomId, meetupController.createMeetupProposal);

module.exports = router;
