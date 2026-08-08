const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, superAdminOnly, auditLog } = require('../middleware/auth');
const brandingController = require('../controllers/branding.controller');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2 MB limit
});

// GET /api/admin/branding
router.get('/', authenticate, superAdminOnly, brandingController.getBranding);

// POST /api/admin/branding/logo
router.post('/logo', authenticate, superAdminOnly, upload.single('logo'), auditLog('UPLOAD_LOGO_DRAFT', 'SYSTEM'), brandingController.uploadLogo);

// POST /api/admin/branding/publish
router.post('/publish', authenticate, superAdminOnly, auditLog('PUBLISH_LOGO', 'SYSTEM'), brandingController.publishLogo);

module.exports = router;
