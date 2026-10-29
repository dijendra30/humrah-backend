// routes/moodRequest.js
// Mounted as: app.use('/api/mood-request', authenticate, enforceLegalAcceptance, moodRequestRoutes)
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/moodRequestController');
const { vibeRequestLimiter } = require('../middleware/rateLimitMiddleware');

// POST /api/mood-request/send               — send a vibe request (rate limited)
router.post('/send',                 vibeRequestLimiter, ctrl.sendRequest);

// GET  /api/mood-request/incoming           — received pending requests
router.get('/incoming',              ctrl.getIncoming);

// GET  /api/mood-request/sent               — sent requests + statuses
router.get('/sent',                  ctrl.getSent);

// POST /api/mood-request/:requestId/accept  — accept + create chat
router.post('/:requestId/accept',    ctrl.acceptRequest);

// POST /api/mood-request/:requestId/decline — decline
router.post('/:requestId/decline',   ctrl.declineRequest);

// GET  /api/mood-request/chats              — my active chat rooms
router.get('/chats',                 ctrl.getMyChatRooms);

// GET  /api/mood-request/chat/:chatRoomId   — single chat room + messages
router.get('/chat/:chatRoomId',      ctrl.getChatRoom);

// POST /api/mood-request/chat/:chatRoomId/message — send message (rate limited)
router.post('/chat/:chatRoomId/message', ctrl.sendMessage);

// Person-to-person chat actions (services/personChatService.js)
// PATCH  /api/mood-request/chat/:chatRoomId/message/:messageId           — edit my message { text }
router.patch('/chat/:chatRoomId/message/:messageId',        ctrl.editMessage);
// DELETE /api/mood-request/chat/:chatRoomId/message/:messageId?scope=me|everyone
router.delete('/chat/:chatRoomId/message/:messageId',       ctrl.deleteMessage);
// POST   /api/mood-request/chat/:chatRoomId/message/:messageId/react     — { emoji } (again = remove)
router.post('/chat/:chatRoomId/message/:messageId/react',   ctrl.reactToMessage);
// POST   /api/mood-request/chat/:chatRoomId/mute                         — { muted: true|false }
router.post('/chat/:chatRoomId/mute',                       ctrl.setMuted);

module.exports = router;
