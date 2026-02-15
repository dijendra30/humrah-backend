// middleware/enforceLegalAcceptance.js
// FULL FILE - CREATE NEW
const User = require('../models/User');
const LegalVersion = require('../models/LegalVersion');

/**
 * Middleware to enforce legal acceptance
 * Use on protected routes that require current legal acceptance
 * 
 * Usage:
 * router.get('/protected', authenticate, enforceLegalAcceptance, handler);
 */
const enforceLegalAcceptance = async (req, res, next) => {
  try {
    // Skip for certain routes
    const exemptRoutes = [
      '/api/legal/versions',
      '/api/legal/accept',
      '/api/auth/logout',
      '/api/legal/my-acceptances'
    ];
    
    if (exemptRoutes.includes(req.path)) {
      return next();
    }
    
    // Ensure user is authenticated
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // Check if user has accepted current legal versions
    const hasAccepted = await req.user.hasAcceptedCurrentLegal();
    
    if (!hasAccepted) {
      // Get current versions
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
    console.error('Enforce legal acceptance error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify legal acceptance'
    });
  }
};

module.exports = { enforceLegalAcceptance };
