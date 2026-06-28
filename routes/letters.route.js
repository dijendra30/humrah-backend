const express = require('express');
const router = express.Router();
const lettersController = require('../controllers/letters.controller');
const { validateLetterCreation, validateLetterReply, validateLetterReport } = require('../validators/letters.validator');
const { lettersWriteLimiter, lettersReadLimiter } = require('../middleware/lettersRateLimit');
const lettersModeration = require('../middleware/lettersModeration');

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
