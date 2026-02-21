// ─────────────────────────────────────────────────────────────────────────────
// FILE: middleware/enforceCommunityAcceptance.js  — CREATE NEW
// ─────────────────────────────────────────────────────────────────────────────
const LegalConfig = require('../config/legalConfig');

/**
 * Middleware: enforceCommunityAcceptance
 *
 * Blocks booking, chat, and profile activation if user has not accepted
 * the current version of the Community Guidelines.
 *
 * Usage:
 *   router.post('/bookings', authenticate, enforceCommunityAcceptance, handler);
 *   router.post('/chat/send', authenticate, enforceCommunityAcceptance, handler);
 *   router.put('/profile/activate', authenticate, enforceCommunityAcceptance, handler);
 */
const enforceCommunityAcceptance = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const currentVersion = LegalConfig.currentCommunityVersion;
    const userVersion    = req.user.acceptedCommunityVersion;

    if (userVersion !== currentVersion) {
      return res.status(428).json({
        success: false,
        message: 'You must accept the Community Guidelines before continuing.',
        code: 'COMMUNITY_ACCEPTANCE_REQUIRED',
        forceCommunityAcceptance: true,        // ← client checks this flag
        requiredVersion: currentVersion,
        userAcceptedVersion: userVersion ?? null
      });
    }

    next();
  } catch (error) {
    console.error('[enforceCommunityAcceptance] error:', error);
    return res.status(500).json({ success: false, message: 'Server error during community acceptance check' });
  }
};

module.exports = { enforceCommunityAcceptance };


