// routes/legal.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const LegalAcceptance = require('../models/LegalAcceptance');
const LegalVersion = require('../models/LegalVersion');
const User = require('../models/User');

// ── IP resolution helper ──────────────────────────────────────────────────────
// Cloudflare sets CF-Connecting-IP to the real client IP.
// Fall back to X-Forwarded-For (Nginx/other proxies), then req.ip.
function resolveClientIP(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

// =============================================
// GET /api/legal/versions
// =============================================
router.get('/versions', async (req, res) => {
  try {
    const [terms, privacy] = await Promise.all([
      LegalVersion.findOne({ documentType: 'TERMS' }),
      LegalVersion.findOne({ documentType: 'PRIVACY' })
    ]);

    if (!terms || !privacy) {
      return res.status(500).json({ success: false, message: 'Legal versions not configured' });
    }

    res.json({
      success: true,
      versions: {
        terms:   { version: terms.currentVersion,   url: terms.url,   effectiveDate: terms.effectiveDate },
        privacy: { version: privacy.currentVersion, url: privacy.url, effectiveDate: privacy.effectiveDate }
      }
    });
  } catch (error) {
    console.error('[GET /api/legal/versions]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch legal versions' });
  }
});

// =============================================
// GET /api/legal/community/version
// =============================================
router.get('/community/version', (req, res) => {
  res.json({
    success: true,
    version: process.env.COMMUNITY_GUIDELINES_VERSION || '1.0',
    url:     process.env.COMMUNITY_GUIDELINES_URL     || 'https://humrah.in/community.html'
  });
});

// =============================================
// POST /api/legal/accept
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
        currentVersions: { terms: termsDoc.currentVersion, privacy: privacyDoc.currentVersion }
      });
    }

    const ipAddress = resolveClientIP(req);  // ← uses CF header

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
      acceptedTermsVersion:    termsVersion,
      acceptedPrivacyVersion:  privacyVersion,
      lastLegalAcceptanceDate: new Date(),
      requiresLegalReacceptance: false
    });

    res.json({
      success: true,
      message: 'Legal acceptance recorded',
      acceptance: {
        acceptedAt:     acceptance.acceptedAt,
        termsVersion:   acceptance.termsVersion,
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
// =============================================
router.post('/community/accept', authenticate, async (req, res) => {
  try {
    const { version, deviceFingerprint } = req.body;

    if (!version || typeof version !== 'string' || !version.trim()) {
      return res.status(400).json({ success: false, message: 'version is required' });
    }
    if (!deviceFingerprint || typeof deviceFingerprint !== 'string' || !deviceFingerprint.trim()) {
      return res.status(400).json({ success: false, message: 'deviceFingerprint is required' });
    }

    const currentVersion = process.env.COMMUNITY_GUIDELINES_VERSION || '1.0';
    if (version !== currentVersion) {
      return res.status(409).json({
        success: false,
        message: 'Community Guidelines version mismatch. Please read and accept the current version.',
        code: 'COMMUNITY_VERSION_MISMATCH',
        requiredVersion:  currentVersion,
        submittedVersion: version
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Idempotent — already accepted current version
    if (user.acceptedCommunityVersion === currentVersion) {
      return res.json({
        success: true,
        message: 'Community guidelines already accepted at current version',
        acceptedCommunityVersion: user.acceptedCommunityVersion,
        communityAcceptedAt:      user.communityAcceptedAt,
        communityAcceptedIP:      user.communityAcceptedIP
      });
    }

    const ipAddress = resolveClientIP(req);  // ← uses CF-Connecting-IP, the real IP

    await user.acceptCommunityGuidelines(version, ipAddress, deviceFingerprint);

    console.log(`✅ Community guidelines v${version} accepted by ${req.userId} from ${ipAddress}`);

    res.json({
      success: true,
      message:                  'Community guidelines acceptance recorded',
      acceptedCommunityVersion: currentVersion,
      communityAcceptedAt:      user.communityAcceptedAt,
      communityAcceptedIP:      ipAddress
    });

  } catch (error) {
    console.error('[POST /api/legal/community/accept]', error);
    res.status(500).json({ success: false, message: 'Failed to record community guidelines acceptance' });
  }
});

// =============================================
// POST /api/legal/log-safety-disclaimer
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

    await user.logSafetyDisclaimer(bookingId, resolveClientIP(req));
    res.json({ success: true, message: 'Safety disclaimer logged' });

  } catch (error) {
    console.error('[POST /api/legal/log-safety-disclaimer]', error);
    res.status(500).json({ success: false, message: 'Failed to log safety disclaimer' });
  }
});

// =============================================
// POST /api/legal/log-video-consent
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

    await user.logVideoConsent(sessionId, resolveClientIP(req));
    res.json({ success: true, message: 'Video consent logged' });

  } catch (error) {
    console.error('[POST /api/legal/log-video-consent]', error);
    res.status(500).json({ success: false, message: 'Failed to log video consent' });
  }
});

// =============================================
// POST /api/legal/request-deletion
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
// =============================================
router.get('/my-acceptances', authenticate, async (req, res) => {
  try {
    const acceptances = await LegalAcceptance.find({ userId: req.userId })
      .sort({ acceptedAt: -1 })
      .limit(50);

    res.json({
      success: true,
      acceptances: acceptances.map(a => ({
        documentType:   a.documentType,
        termsVersion:   a.termsVersion,
        privacyVersion: a.privacyVersion,
        acceptedAt:     a.acceptedAt,
        platform:       a.platform
      }))
    });
  } catch (error) {
    console.error('[GET /api/legal/my-acceptances]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch acceptance history' });
  }
});

module.exports = router;
