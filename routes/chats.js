// routes/chats.js
const express = require('express');
const router = express.Router();
const unifiedChatController = require('../controllers/unifiedChatController');
const { auth } = require('../middleware/auth');

// @route   GET /api/chats
// @desc    Get all unified chats for the user (aggregates Chat, RandomBookingChat, MoodChat)
// @access  Private
router.get('/', auth, unifiedChatController.getUnifiedChats);

// @route   GET /api/chats/:chatId/messages
// @desc    Get messages for a specific Chat
// @access  Private
const founderChatController = require('../controllers/founderChatController');
router.get('/:chatId/messages', auth, founderChatController.getChatMessages);

module.exports = router;
