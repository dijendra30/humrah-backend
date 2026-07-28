const express = require('express');
const router = express.Router();
const founderController = require('../controllers/founderController');
const founderChatController = require('../controllers/founderChatController');
const { upload } = require('../config/cloudinary');
const { founderMessageBurstLimiter } = require('../middleware/rateLimitMiddleware');
const { auth, adminOnly } = require('../middleware/auth');

// ============================================================================
// ADMIN ENDPOINTS (Requires SAFETY_ADMIN or SUPER_ADMIN)
// ============================================================================

// Note: Ensure admin routes are placed before /messages/:id so 'admin' is not treated as an ID
router.get('/admin/stats', adminOnly, founderController.getDashboardStats);
router.get('/admin/messages', adminOnly, founderController.listMessages);
router.get('/admin/messages/:id', adminOnly, founderController.getMessageForAdmin);
router.put('/admin/messages/:id', adminOnly, founderController.updateMessageStatus);
router.post('/admin/messages/:id/reply', adminOnly, founderController.replyToMessage);
router.post('/admin/messages/:id/start-discussion', adminOnly, founderChatController.startDiscussion);
router.put('/admin/chats/:chatId/status', adminOnly, founderChatController.updateChatStatus);

// ============================================================================
// USER ENDPOINTS (Requires USER)
// ============================================================================

router.post(
  '/messages',
  founderMessageBurstLimiter,
  upload.array('attachments', 2),
  founderController.submitMessage
);

router.get('/messages', auth, founderController.getUserMessages);
router.get('/messages/:id', auth, founderController.getMessageDetails);

// ============================================================================
// FOUNDER CHAT ENDPOINTS (Shared by Admin & User via auth)
// ============================================================================
router.get('/chats', auth, founderChatController.getUserChats);
router.get('/chats/:chatId/messages', auth, founderChatController.getChatMessages);
router.post('/chats/:chatId/messages', auth, founderChatController.sendMessage);

module.exports = router;
