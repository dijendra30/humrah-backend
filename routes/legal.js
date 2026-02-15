// routes/legal.js
// FULL FILE - CREATE NEW
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const LegalAcceptance = require('../models/LegalAcceptance');
const LegalVersion = require('../models/LegalVersion');
const User = require('../models/User');

/**
 * GET /api/legal/versions
 * Get current legal document versions (PUBLIC - no auth required)
 */
router.get('/versions', async (req, res) => {
  try {
    const [terms, privacy] = await Promise.all([
      LegalVersion.findOne({ documentType: 'TERMS' }),
      LegalVersion.findOne({ documentType: 'PRIVACY' })
    ]);
    
    if (!terms || !privacy) {
      return res.status(500).json({
        success: false,
        message: 'Legal versions not configured'
      });
    }
    
    res.json({
      success: true,
      versions: {
        terms: {
          version: terms.currentVersion,
          url: terms.url,
          effectiveDate: terms.effectiveDate
        },
        privacy: {
          version: privacy.currentVersion,
          url: privacy.url,
          effectiveDate: privacy.effectiveDate
        }
      }
    });
  } catch (error) {
    console.error('Get versions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch legal versions'
    });
  }
});

/**
 * POST /api/legal/accept
 * Log legal acceptance (requires authentication)
 */
router.post('/accept', authenticate, async (req, res) => {
  try {
    const { termsVersion, privacyVersion, deviceFingerprint, platform, appVersion } = req.body;
    
    if (!termsVersion || !privacyVersion || !deviceFingerprint || !platform) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }
    
    // Verify versions are current
    const [termsDoc, privacyDoc] = await Promise.all([
      LegalVersion.findOne({ documentType: 'TERMS' }),
      LegalVersion.findOne({ documentType: 'PRIVACY' })
    ]);
    
    if (!termsDoc || !privacyDoc) {
      return res.status(500).json({
        success: false,
        message: 'Legal versions not configured'
      });
    }
    
    if (termsVersion !== termsDoc.currentVersion || privacyVersion !== privacyDoc.currentVersion) {
      return res.status(400).json({
        success: false,
        message: 'Version mismatch. Please refresh and accept current versions.',
        currentVersions: {
          terms: termsDoc.currentVersion,
          privacy: privacyDoc.currentVersion
        }
      });
    }
    
    // Get IP address
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Create acceptance record
    const acceptance = new LegalAcceptance({
      userId: req.userId,
      documentType: 'BOTH',
      termsVersion,
      privacyVersion,
      acceptedAt: new Date(),
      ipAddress,
      deviceFingerprint,
      userAgent: req.get('user-agent'),
      platform,
      appVersion
    });
    
    await acceptance.save();
    
    // Update user record
    await User.findByIdAndUpdate(req.userId, {
      acceptedTermsVersion: termsVersion,
      acceptedPrivacyVersion: privacyVersion,
      lastLegalAcceptanceDate: new Date(),
      requiresLegalReacceptance: false
    });
    
    res.json({
      success: true,
      message: 'Legal acceptance recorded',
      acceptance: {
        acceptedAt: acceptance.acceptedAt,
        termsVersion: acceptance.termsVersion,
        privacyVersion: acceptance.privacyVersion
      }
    });
  } catch (error) {
    console.error('Accept legal error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record legal acceptance'
    });
  }
});

/**
 * POST /api/legal/log-safety-disclaimer
 * Log safety disclaimer acceptance
 */
router.post('/log-safety-disclaimer', authenticate, async (req, res) => {
  try {
    const { bookingId } = req.body;
    
    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: 'Booking ID required'
      });
    }
    
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    await user.logSafetyDisclaimer(bookingId, ipAddress);
    
    res.json({
      success: true,
      message: 'Safety disclaimer logged'
    });
  } catch (error) {
    console.error('Log safety disclaimer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to log safety disclaimer'
    });
  }
});

/**
 * POST /api/legal/log-video-consent
 * Log video verification consent
 */
router.post('/log-video-consent', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Session ID required'
      });
    }
    
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    await user.logVideoConsent(sessionId, ipAddress);
    
    res.json({
      success: true,
      message: 'Video consent logged'
    });
  } catch (error) {
    console.error('Log video consent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to log video consent'
    });
  }
});

/**
 * POST /api/legal/request-deletion
 * Request account and data deletion (GDPR)
 */
router.post('/request-deletion', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Mark user for deletion
    user.status = 'PENDING_DELETION';
    user.deletionRequestedAt = new Date();
    await user.save();
    
    // Calculate deletion date (30 days from now)
    const deletionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    // TODO: Send email notification
    // TODO: Create deletion job in queue
    
    res.json({
      success: true,
      message: 'Deletion request received. Your data will be permanently deleted within 30 days as required by GDPR.',
      deletionDate: deletionDate.toISOString()
    });
  } catch (error) {
    console.error('Request deletion error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process deletion request'
    });
  }
});

/**
 * GET /api/legal/my-acceptances
 * Get user's legal acceptance history
 */
router.get('/my-acceptances', authenticate, async (req, res) => {
  try {
    const acceptances = await LegalAcceptance.find({ userId: req.userId })
      .sort({ acceptedAt: -1 })
      .limit(50);
    
    res.json({
      success: true,
      acceptances: acceptances.map(a => ({
        documentType: a.documentType,
        termsVersion: a.termsVersion,
        privacyVersion: a.privacyVersion,
        acceptedAt: a.acceptedAt,
        platform: a.platform
      }))
    });
  } catch (error) {
    console.error('Get acceptances error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch acceptance history'
    });
  }
});

module.exports = router;
