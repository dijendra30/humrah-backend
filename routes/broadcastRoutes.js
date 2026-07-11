// routes/broadcastRoutes.js — Admin-protected broadcast API routes (Phase 1)
// All routes require authenticate + adminOnly middleware.
// Mounted at /api/admin/broadcasts in server.js.

const express = require('express');
const router  = express.Router();

const ctrl = require('../controllers/broadcastController');
const { auditLog } = require('../middleware/auth');
const {
  validateCreateBroadcast,
  validateUpdateDraft,
  validateAiRephrase,
  validateBroadcastId,
  validatePreview,
} = require('../validators/broadcast.validator');

// =============================================
// BROADCAST CRUD
// =============================================

// Create a new broadcast (DRAFT)
router.post('/',
  validateCreateBroadcast,
  auditLog('CREATE_BROADCAST', 'SYSTEM'),
  ctrl.createBroadcast
);

// List broadcasts (paginated, filterable)
router.get('/',
  ctrl.getBroadcastList
);

// Get single broadcast details with analytics
router.get('/:id',
  validateBroadcastId,
  ctrl.getBroadcastDetails
);

// Update a draft broadcast
router.put('/:id',
  validateBroadcastId,
  validateUpdateDraft,
  auditLog('UPDATE_BROADCAST', 'SYSTEM'),
  ctrl.updateDraft
);

// Delete a broadcast (DRAFT or FAILED only)
router.delete('/:id',
  validateBroadcastId,
  auditLog('DELETE_BROADCAST', 'SYSTEM'),
  ctrl.deleteBroadcast
);

// =============================================
// BROADCAST ACTIONS
// =============================================

// Preview audience size (no notifications sent)
router.post('/preview',
  validatePreview,
  ctrl.previewBroadcastAudience
);

// Send a test broadcast to the admin's device
router.post('/:id/test',
  validateBroadcastId,
  ctrl.testBroadcast
);

// Send a broadcast to its audience
router.post('/:id/send',
  validateBroadcastId,
  auditLog('SEND_BROADCAST', 'SYSTEM'),
  ctrl.sendBroadcast
);

// =============================================
// AI
// =============================================

// AI-powered content rephrase (on-demand only)
router.post('/ai-rephrase',
  validateAiRephrase,
  auditLog('AI_REPHRASE_BROADCAST', 'SYSTEM'),
  ctrl.aiRephrase
);

module.exports = router;
