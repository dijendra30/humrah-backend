const express = require('express');
const router = express.Router();
const founderController = require('../controllers/founderController');
const { upload } = require('../config/cloudinary');
const { founderMessageBurstLimiter } = require('../middleware/rateLimitMiddleware');
const { adminOnly } = require('../middleware/auth');

// ============================================================================
// ADMIN ENDPOINTS (Requires SAFETY_ADMIN or SUPER_ADMIN)
// ============================================================================

// Note: Ensure admin routes are placed before /messages/:id so 'admin' is not treated as an ID
router.get('/admin/stats', adminOnly, founderController.getDashboardStats);
router.get('/admin/messages', adminOnly, founderController.listMessages);
router.get('/admin/messages/:id', adminOnly, founderController.getMessageForAdmin);
router.put('/admin/messages/:id', adminOnly, founderController.updateMessageStatus);
router.post('/admin/messages/:id/reply', adminOnly, founderController.replyToMessage);

// ============================================================================
// USER ENDPOINTS (Requires USER)
// ============================================================================

router.post(
  '/messages',
  founderMessageBurstLimiter,
  upload.array('attachments', 2),
  founderController.submitMessage
);

router.get('/messages', founderController.getUserMessages);
router.get('/messages/:id', founderController.getMessageDetails);

module.exports = router;
