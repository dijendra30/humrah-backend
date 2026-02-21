// routes/legal.js - UPDATED WITH COMMUNITY GUIDELINES ACCEPTANCE
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const LegalAcceptance = require('../models/LegalAcceptance');
const LegalVersion = require('../models/LegalVersion');
const User = require('../models/User');

// =============================================
// GET /api/legal/versions
// Get current Terms & Privacy versions — PUBLIC, no auth
// =============================================
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
    console.error('[GET /api/legal/versions]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch legal versions' });
  }
});

// =============================================
// GET /api/legal/community/version
// Get current community guidelines version — PUBLIC, no auth
// Android reads this on launch to know what version to send
// =============================================
router.get('/community/version', (req, res) => {
  res.json({
    success: true,
    version: process.env.COMMUNITY_GUIDELINES_VERSION || '1.0',
    url: process.env.COMMUNITY_GUIDELINES_URL || 'https://humrah.in/community.html'
  });
});

// =============================================
// POST /api/legal/accept
// Record Terms & Privacy acceptance — requires auth
// =============================================
router.post('/accept', authenticate, async (req, res) => {
  try {
    const { termsVersion, privacyVersion, deviceFingerprint, platform, appVersion } = req.body;

    if (!termsVersion || !privacyVersion || !deviceFingerprint || !platform) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: termsVersion, privacyVersion, deviceFingerprint, platform'
      });
    }

    const [termsDoc, privacyDoc] = await Promise.all([
      LegalVersion.findOne({ documentType: 'TERMS' }),
      LegalVersion.findOne({ documentType: 'PRIVACY' })
    ]);

    if (!termsDoc || !privacyDoc) {
      return res.status(500).json({ success: false, message: 'Legal versions not configured' });
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

    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim()
      || req.ip
      || req.connection.remoteAddress
      || 'unknown';

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
    console.error('[POST /api/legal/accept]', error);
    res.status(500).json({ success: false, message: 'Failed to record legal acceptance' });
  }
});

// =============================================
// POST /api/legal/community/accept
// Record Community Guidelines acceptance — requires auth
//
// Body:  { version: "1.0", deviceFingerprint: "android_id_here" }
// Steps:
//   1. Validates JWT via authenticate middleware
//   2. Validates submitted version matches COMMUNITY_GUIDELINES_VERSION env var
//   3. Idempotent — returns 200 if user already accepted current version
//   4. Writes acceptedCommunityVersion, communityAcceptedAt, IP, device to user doc
// =============================================
router.post('/community/accept', authenticate, async (req, res) => {
  try {
    const { version, deviceFingerprint } = req.body;

    // ── Input validation ──────────────────────────────────────────────────
    if (!version || typeof version !== 'string' || !version.trim()) {
      return res.status(400).json({
        success: false,
        message: 'version is required'
      });
    }

    if (!deviceFingerprint || typeof deviceFingerprint !== 'string' || !deviceFingerprint.trim()) {
      return res.status(400).json({
        success: false,
        message: 'deviceFingerprint is required'
      });
    }

    // ── Version check against server config ───────────────────────────────
    const currentVersion = process.env.COMMUNITY_GUIDELINES_VERSION || '1.0';

    if (version !== currentVersion) {
      return res.status(409).json({
        success: false,
        message: 'Community Guidelines version mismatch. Please read and accept the current version.',
        code: 'COMMUNITY_VERSION_MISMATCH',
        requiredVersion: currentVersion,
        submittedVersion: version
      });
    }

    // ── Load user ─────────────────────────────────────────────────────────
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // ── Idempotency — already on current version ──────────────────────────
    if (user.acceptedCommunityVersion === currentVersion) {
      return res.json({
        success: true,
        message: 'Community guidelines already accepted at current version',
        acceptedCommunityVersion: user.acceptedCommunityVersion,
        communityAcceptedAt: user.communityAcceptedAt
      });
    }

    // ── Capture real IP (supports proxies / Cloudflare / Nginx) ──────────
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim()
      || req.ip
      || req.connection.remoteAddress
      || 'unknown';

    // ── Persist via model method ──────────────────────────────────────────
    await user.acceptCommunityGuidelines(version, ipAddress, deviceFingerprint);

    console.log(`✅ Community guidelines v${version} accepted by user ${req.userId} from ${ipAddress}`);

    res.json({
      success: true,
      message: 'Community guidelines acceptance recorded',
      acceptedCommunityVersion: currentVersion,
      communityAcceptedAt: user.communityAcceptedAt
    });

  } catch (error) {
    console.error('[POST /api/legal/community/accept]', error);
    res.status(500).json({ success: false, message: 'Failed to record community guidelines acceptance' });
  }
});

// =============================================
// POST /api/legal/log-safety-disclaimer
// Log safety disclaimer for a booking — requires auth
// =============================================
router.post('/log-safety-disclaimer', authenticate, async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ success: false, message: 'bookingId is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim()
      || req.ip
      || 'unknown';

    await user.logSafetyDisclaimer(bookingId, ipAddress);

    res.json({ success: true, message: 'Safety disclaimer logged' });
  } catch (error) {
    console.error('[POST /api/legal/log-safety-disclaimer]', error);
    res.status(500).json({ success: false, message: 'Failed to log safety disclaimer' });
  }
});

// =============================================
// POST /api/legal/log-video-consent
// Log video verification consent — requires auth
// =============================================
router.post('/log-video-consent', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim()
      || req.ip
      || 'unknown';

    await user.logVideoConsent(sessionId, ipAddress);

    res.json({ success: true, message: 'Video consent logged' });
  } catch (error) {
    console.error('[POST /api/legal/log-video-consent]', error);
    res.status(500).json({ success: false, message: 'Failed to log video consent' });
  }
});

// =============================================
// POST /api/legal/request-deletion
// GDPR — request account & data deletion — requires auth
// =============================================
router.post('/request-deletion', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.status = 'PENDING_DELETION';
    user.deletionRequestedAt = new Date();
    await user.save();

    const deletionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // TODO: Queue a deletion job and send email confirmation

    res.json({
      success: true,
      message: 'Deletion request received. Your data will be permanently deleted within 30 days as required by GDPR.',
      deletionDate: deletionDate.toISOString()
    });
  } catch (error) {
    console.error('[POST /api/legal/request-deletion]', error);
    res.status(500).json({ success: false, message: 'Failed to process deletion request' });
  }
});

// =============================================
// GET /api/legal/my-acceptances
// User's Terms & Privacy acceptance history — requires auth
// =============================================
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
    console.error('[GET /api/legal/my-acceptances]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch acceptance history' });
  }
});

module.exports = router;
