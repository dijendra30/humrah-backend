const express = require('express');
const router = express.Router();
const lettersController = require('../controllers/letters.controller');
const letterNotifController = require('../controllers/letterNotificationController');
const { validateLetterCreation, validateLetterReply, validateLetterReport } = require('../validators/letters.validator');
const { lettersWriteLimiter, lettersReadLimiter } = require('../middleware/lettersRateLimit');
const lettersModeration = require('../middleware/lettersModeration');

// ── Activity Inbox (must be before /:id routes to avoid "activity" being matched as a letter ID)
router.get('/activity',          lettersReadLimiter,  letterNotifController.getActivity);
router.get('/activity/unread-count', lettersReadLimiter, letterNotifController.getUnreadCount);
router.patch('/activity/read-all', lettersWriteLimiter, letterNotifController.markAllRead);
router.patch('/activity/:id/read', lettersWriteLimiter, letterNotifController.markRead);

// CREATE a new letter
router.post(
  '/',
  lettersWriteLimiter,
  validateLetterCreation,
  lettersModeration,
  lettersController.createLetter.bind(lettersController)
);

// GET feed
router.get(
  '/',
  lettersReadLimiter,
  lettersController.getFeed.bind(lettersController)
);

// GET my letters
router.get(
  '/my-letters',
  lettersReadLimiter,
  lettersController.getMyLetters.bind(lettersController)
);

// GET single letter details
router.get(
  '/:id',
  lettersReadLimiter,
  lettersController.getLetterById.bind(lettersController)
);

// REPLY to a letter
router.post(
  '/:id/replies',
  lettersWriteLimiter,
  validateLetterReply,
  lettersModeration,
  lettersController.createReply.bind(lettersController)
);

// REACT to a letter
router.post(
  '/:id/react',
  lettersWriteLimiter,
  lettersController.reactToLetter.bind(lettersController)
);

// REMOVE reaction
router.delete(
  '/:id/react',
  lettersWriteLimiter,
  lettersController.unreactToLetter.bind(lettersController)
);

// REPORT a letter
router.post(
  '/:id/report',
  lettersWriteLimiter,
  validateLetterReport,
  lettersController.reportLetter.bind(lettersController)
);

// (Admin stats endpoint could go here or in admin routes)
// GET /api/letters/admin/stats
router.get(
  '/admin/stats',
  lettersReadLimiter,
  // adminOnly middleware should be added here in a real scenario
  lettersController.getStats.bind(lettersController)
);

module.exports = router;
