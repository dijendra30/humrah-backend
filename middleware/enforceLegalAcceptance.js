// middleware/enforceLegalAcceptance.js
const LegalVersion = require('../models/LegalVersion');

// =============================================
// EXEMPT ROUTES
// These paths bypass all legal/community checks.
// They are the routes users use to GET into compliance,
// so we must never block them.
// =============================================
const EXEMPT_PATHS = new Set([
  '/api/legal/versions',
  '/api/legal/accept',
  '/api/legal/community/version',
  '/api/legal/community/accept',
  '/api/legal/my-acceptances',
  '/api/auth/logout'
]);

// =============================================
// ✅ MIDDLEWARE 1: enforceLegalAcceptance
//
// Checks user has accepted current Terms & Privacy versions.
// Applied globally to all protected routes in server.js.
//
// Returns 428 with code LEGAL_ACCEPTANCE_REQUIRED if not accepted.
// Android intercepts 428 → shows the Terms/Privacy acceptance screen.
//
// Usage:
//   app.use('/api/bookings', authenticate, enforceLegalAcceptance, bookingRoutes);
// =============================================
const enforceLegalAcceptance = async (req, res, next) => {
  try {
    if (EXEMPT_PATHS.has(req.path)) {
      return next();
    }

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const hasAccepted = await req.user.hasAcceptedCurrentLegal();

    if (!hasAccepted) {
      const [termsDoc, privacyDoc] = await Promise.all([
        LegalVersion.findOne({ documentType: 'TERMS' }),
        LegalVersion.findOne({ documentType: 'PRIVACY' })
      ]);

      return res.status(428).json({
        success: false,
        message: 'Legal acceptance required',
        code: 'LEGAL_ACCEPTANCE_REQUIRED',
        requiresAcceptance: true,
        currentVersions: {
          terms: {
            version: termsDoc?.currentVersion,
            url: termsDoc?.url
          },
          privacy: {
            version: privacyDoc?.currentVersion,
            url: privacyDoc?.url
          }
        },
        userVersions: {
          terms: req.user.acceptedTermsVersion,
          privacy: req.user.acceptedPrivacyVersion
        }
      });
    }

    next();
  } catch (error) {
    console.error('[enforceLegalAcceptance]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify legal acceptance'
    });
  }
};

// =============================================
// ✅ MIDDLEWARE 2: enforceCommunityAcceptance
//
// Checks user has accepted the current Community Guidelines version.
// Version is driven by COMMUNITY_GUIDELINES_VERSION env var —
// bump it and redeploy to force ALL users to re-accept immediately.
// No separate legalConfig.js file needed.
//
// Returns 428 with code COMMUNITY_ACCEPTANCE_REQUIRED if not accepted.
// Android OkHttp interceptor checks forceCommunityAcceptance flag
// and navigates user to the Trust & Safety section.
//
// Usage:
//   app.use('/api/bookings',   authenticate, enforceLegalAcceptance, enforceCommunityAcceptance, bookingRoutes);
//   app.use('/api/messages',   authenticate, enforceLegalAcceptance, enforceCommunityAcceptance, messageRoutes);
//   app.use('/api/companions', authenticate, enforceLegalAcceptance, enforceCommunityAcceptance, companionRoutes);
// =============================================
const enforceCommunityAcceptance = (req, res, next) => {
  try {
    if (EXEMPT_PATHS.has(req.path)) {
      return next();
    }

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const currentVersion = process.env.COMMUNITY_GUIDELINES_VERSION || '1.0';
    const userVersion    = req.user.acceptedCommunityVersion;

    if (userVersion !== currentVersion) {
      return res.status(428).json({
        success: false,
        message: 'You must accept the Community Guidelines before continuing.',
        code: 'COMMUNITY_ACCEPTANCE_REQUIRED',
        forceCommunityAcceptance: true,   // Android OkHttp interceptor checks this flag
        requiredVersion: currentVersion,
        userAcceptedVersion: userVersion ?? null,
        guidelinesUrl: process.env.COMMUNITY_GUIDELINES_URL || 'https://humrah.in/community.html'
      });
    }

    next();
  } catch (error) {
    console.error('[enforceCommunityAcceptance]', error);
    res.status(500).json({
      success: false,
      message: 'Server error during community acceptance check'
    });
  }
};

// =============================================
// ✅ EXPORTS
// =============================================
module.exports = {
  enforceLegalAcceptance,
  enforceCommunityAcceptance
};
