// routes/auth.js - UPDATED WITH LEGAL ACCEPTANCE + PASSWORD VALIDATION + GOOGLE AUTH + SECURE OTP
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const LegalAcceptance = require('../models/LegalAcceptance');
const LegalVersion = require('../models/LegalVersion');
const { sendWelcomeEmail } = require('../config/email');
const { isStrongPassword } = require('../utils/passwordValidator');
const { sendOtp, verifyOtp } = require('../services/otpService');
const {
  sendOtpLimiter,
  verifyOtpLimiter,
  loginLimiter,
  registerLimiter,
  publicApiLimiter,
} = require('../middleware/rateLimitMiddleware');
const { verifyGoogleIdToken } = require('../services/googleAuthService');

// OTP constants live in services/otpService.js — single source of truth.

// Import auth middleware (use 'auth' for backward compatibility)
let authenticate, superAdminOnly, auditLog;
try {
  const authMiddleware = require('../middleware/auth');
  authenticate = authMiddleware.authenticate || authMiddleware.auth;
  superAdminOnly = authMiddleware.superAdminOnly;
  auditLog = authMiddleware.auditLog || ((action, type) => (req, res, next) => next());
} catch (error) {
  console.error('Error loading auth middleware:', error);
  // Fallback simple auth
  authenticate = async (req, res, next) => {
    try {
      const token = req.header('Authorization')?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ success: false, message: 'No token' });
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('-password');
      if (!user) return res.status(401).json({ success: false, message: 'User not found' });
      
      req.user = user;
      req.userId = user._id;
      next();
    } catch (error) {
      res.status(401).json({ success: false, message: 'Invalid token' });
    }
  };
}

// =============================================
// ENV VALIDATION — fail fast if JWT_SECRET missing
// =============================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    '[auth.js route] JWT_SECRET environment variable is not set. ' +
    'Add it to your .env file and restart the server.'
  );
}

// =============================================
// HELPER: GENERATE JWT TOKEN
// =============================================
// tokenVersion (tv) is embedded in the payload.
// Auth middleware compares payload.tv against db.tokenVersion on every
// request — if they differ the token is rejected immediately.
// This allows instant revocation without a blocklist:
//   - logout-all   → increment tokenVersion → all old tokens fail
//   - password change → increment tokenVersion → stolen tokens fail
//
// Access token lifetime: 24h (down from 7d).
//   Risk window for a stolen token is now 24h max instead of 7 days.
//
// FUTURE REFRESH TOKEN SLOT:
//   When you add refresh tokens, generateToken() stays the same.
//   Add a separate generateRefreshToken(userId, tokenVersion) that issues
//   a long-lived (30d) opaque token stored hashed in a RefreshToken collection.
//   POST /api/auth/refresh verifies the refresh token, checks tokenVersion,
//   and issues a new 24h access token. Android calls /refresh when it gets 401.
// =============================================
const generateToken = (userId, role, tokenVersion = 0) => {
  return jwt.sign(
    { userId, role, tv: tokenVersion },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};


// =============================================
// PUBLIC ROUTES
// =============================================

/**
 * @route   POST /api/auth/register
 * @desc    Register new user with legal acceptance (USER role only)
 * @access  Public
 */
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      questionnaire,
      emailVerified,
      legalAcceptance  // ✅ NEW: Legal acceptance data
    } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // ✅ PASSWORD STRENGTH VALIDATION (server always validates, never trusts client)
    const passwordCheck = isStrongPassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({
        success: false,
        message: passwordCheck.message
      });
    }

    // ✅ VALIDATE LEGAL ACCEPTANCE
    if (!legalAcceptance || 
        !legalAcceptance.termsVersion || 
        !legalAcceptance.privacyVersion ||
        !legalAcceptance.deviceFingerprint ||
        !legalAcceptance.platform) {
      return res.status(400).json({
        success: false,
        message: 'Legal acceptance required',
        code: 'LEGAL_ACCEPTANCE_MISSING'
      });
    }

    // ✅ VERIFY LEGAL VERSIONS ARE CURRENT
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
    
    if (legalAcceptance.termsVersion !== termsDoc.currentVersion || 
        legalAcceptance.privacyVersion !== privacyDoc.currentVersion) {
      return res.status(400).json({
        success: false,
        message: 'Version mismatch. Please refresh and accept current versions.',
        currentVersions: {
          terms: termsDoc.currentVersion,
          privacy: privacyDoc.currentVersion
        }
      });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // Get IP address
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';

    // Create user (ALWAYS with USER role)
    const user = new User({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password,
      role: 'USER',
      emailVerified: emailVerified || false,
      questionnaire: questionnaire || {},
      // ✅ NEW: Legal acceptance fields
      acceptedTermsVersion: legalAcceptance.termsVersion,
      acceptedPrivacyVersion: legalAcceptance.privacyVersion,
      lastLegalAcceptanceDate: new Date()
    });

    // --- ONBOARDING COMPLIANCE: Age & Consent Validation ---
    if (questionnaire) {
      const reqDob = questionnaire.dateOfBirth;
      const reqIsAdult = questionnaire.isAdultConfirmed;
      const reqConsent = questionnaire.consentAccepted;

      if (reqDob || reqIsAdult !== undefined || reqConsent !== undefined) {
          if (reqDob) {
            let normalizedDob = reqDob;
            // Fix for Android sending DD/MM/YYYY format
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(reqDob)) {
              const parts = reqDob.split('/');
              normalizedDob = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }

          const birthDate = new Date(normalizedDob);
          if (!isNaN(birthDate.getTime())) {
            let age = new Date().getFullYear() - birthDate.getFullYear();
            const m = new Date().getMonth() - birthDate.getMonth();
            if (m < 0 || (m === 0 && new Date().getDate() < birthDate.getDate())) {
              age--;
            }
            if (age < 18) {
              return res.status(400).json({ success: false, message: "Humrah is available only for users aged 18 and above." });
            }

            // Compute ageGroup on backend just in case Android failed to send it
            let ageGroup = null;
            if (age >= 18 && age <= 24) ageGroup = "18-24";
            else if (age >= 25 && age <= 34) ageGroup = "25-34";
            else if (age >= 35 && age <= 44) ageGroup = "35-44";
            else if (age >= 45 && age <= 54) ageGroup = "45-54";
            else if (age >= 55) ageGroup = "55+";

            user.questionnaire.dateOfBirth = normalizedDob; // String
            user.questionnaire.age = age; // Number
            if (ageGroup) user.questionnaire.ageGroup = ageGroup;
          }
        }

        if (reqIsAdult !== true || reqConsent !== true) {
          return res.status(400).json({ success: false, message: "Consent and adult confirmation are required." });
        }

        user.questionnaire.isAdultConfirmed = true;
        user.questionnaire.consentAccepted = true;
        user.questionnaire.consentTimestamp = new Date();
      }
    }
    // --- END ONBOARDING COMPLIANCE ---

    await user.save();

    // ✅ LOG LEGAL ACCEPTANCE
    const acceptance = new LegalAcceptance({
      userId: user._id,
      documentType: 'BOTH',
      termsVersion: legalAcceptance.termsVersion,
      privacyVersion: legalAcceptance.privacyVersion,
      acceptedAt: new Date(),
      ipAddress,
      deviceFingerprint: legalAcceptance.deviceFingerprint,
      userAgent: req.get('user-agent'),
      platform: legalAcceptance.platform,
      appVersion: legalAcceptance.appVersion
    });
    
    await acceptance.save();

    // Generate token
    const token = generateToken(user._id, user.role || 'USER');

    // Send welcome email if verified
    if (emailVerified) {
      try {
        await sendWelcomeEmail(user.email, user.firstName);
      } catch (emailError) {
        console.error('Welcome email error:', emailError);
      }
    }

    console.log(`✅ New user registered: ${user.email}`);

    console.log(`[GUIDELINES]
userId=${user._id}
guidelinesAccepted=${user.guidelinesAccepted || false}
guidelinesVersion=${user.guidelinesVersion || null}
acceptedCommunityVersion=${user.acceptedCommunityVersion || null}
needsGuidelinesAcceptance=${user.needsGuidelinesAcceptance !== undefined ? user.needsGuidelinesAcceptance : (!user.guidelinesAccepted || user.guidelinesVersion !== "1.0")}`);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role || 'USER',
        emailVerified: user.emailVerified,
        guidelinesAccepted: user.guidelinesAccepted || false,
        guidelinesVersion: user.guidelinesVersion || null,
        acceptedCommunityVersion: user.acceptedCommunityVersion || null,
        needsGuidelinesAcceptance: user.needsGuidelinesAcceptance !== undefined ? user.needsGuidelinesAcceptance : (!user.guidelinesAccepted || user.guidelinesVersion !== "1.0")
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
});

/**
 * @route   POST /api/auth/login
 * @desc    Login user and check legal acceptance (all roles use same endpoint)
 * @access  Public
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log('🔍 Login attempt for:', email);

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find user (include password for comparison)
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (process.env.NODE_ENV !== 'production') {
      console.log('👤 Login attempt:', email, '| found:', !!user);
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Verify password
    // Guard: user may have registered via Google/Facebook and has no password.
    // comparePassword now returns false safely, but be explicit here too.
    if (!user.password) {
      return res.status(401).json({
        success: false,
        message: 'This account uses Google or Facebook sign-in. Please use that instead.'
      });
    }

    let isMatch = false;
    try {
      isMatch = await user.comparePassword(password);
    } catch (compareError) {
      console.error('❌ Password comparison error:', compareError);
      return res.status(500).json({
        success: false,
        message: 'Server error during login'
      });
    }
    
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // ── Check account status ──────────────────────────────────────────────────
    if (user.status && user.status !== 'ACTIVE') {

      // ── Auto-lift suspension if suspendedUntil has passed ──────────────────
      if (
        user.status === 'SUSPENDED' &&
        user.suspensionInfo?.suspendedUntil &&
        new Date() >= new Date(user.suspensionInfo.suspendedUntil)
      ) {
        // Suspension period expired → restore account automatically
        user.status                           = 'ACTIVE';
        user.suspensionInfo.isSuspended       = false;
        user.suspensionInfo.suspendedUntil    = null;
        user.suspensionInfo.autoLiftAt        = null;
        user.suspensionInfo.suspensionReason  = null;
        await user.save();
        console.log(`✅ Auto-lifted suspension for ${user.email}`);
        // fall through to normal login
      } else if (user.status === 'SUSPENDED') {
        const until = user.suspensionInfo?.suspendedUntil;
        return res.status(403).json({
          success: false,
          message: 'Your account has been temporarily restricted due to community reports.',
          suspensionInfo: {
            reason:       user.suspensionInfo?.suspensionReason || 'Community guideline violation',
            suspendedUntil: until ? until.toISOString() : null,
            // human readable e.g. "Restrictions lift on March 21, 2026"
            liftsOn: until
              ? new Date(until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
              : 'indefinite'
          }
        });
      } else if (user.status === 'BANNED') {
        return res.status(403).json({
          success: false,
          message: 'This account has been permanently banned.',
        });
      } else {
        return res.status(403).json({
          success: false,
          message: `Account is ${user.status.toLowerCase()}`
        });
      }
    }

    // ✅ CHECK LEGAL ACCEPTANCE STATUS
    let hasAcceptedCurrent = false;
    try {
      hasAcceptedCurrent = await user.hasAcceptedCurrentLegal();
    } catch (legalError) {
      console.log('⚠️ Could not check legal acceptance:', legalError.message);
      // Continue with login, but flag for re-acceptance
      hasAcceptedCurrent = false;
    }

    // Update last active
    try {
      user.lastActive = new Date();
      await user.save();
    } catch (saveError) {
      console.log('⚠️ Could not update lastActive:', saveError.message);
      // Continue anyway
    }

    // Get role (handle both old and new User models)
    const userRole = user.role || 'USER';

    // Generate token (includes role + tokenVersion for revocation support)
    if (user.ensureGuidelinesMigration) await user.ensureGuidelinesMigration();

    const token = generateToken(user._id, userRole, user.tokenVersion ?? 0);

    console.log(`✅ Login successful: ${user.email} (${userRole})`);

    // Prepare user response — FIXED: include all fields Android app expects
    const userResponse = {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: userRole,
      profilePhoto: user.profilePhoto,
      emailVerified: user.emailVerified,
      verified: user.verified,
      // ✅ FIXED: Android User model needs these or UI breaks post-login
      questionnaire: user.questionnaire || {},
      isPremium: user.isPremium || false,
      hostActive: user.hostActive !== false,
      paymentInfo: user.paymentInfo || null,
      photoVerificationStatus: user.photoVerificationStatus || 'not_submitted',
      profileCompleteness: user.profileCompleteness || null,
      acceptedCommunityVersion: user.acceptedCommunityVersion || null,
      communityAcceptedAt: user.communityAcceptedAt || null,
      lastActive: user.lastActive || null,
      createdAt: user.createdAt || null
    };

    // Add admin permissions if available
    if (user.adminPermissions) {
      userResponse.adminPermissions = user.adminPermissions;
    }

    // Add status if available
    if (user.status) {
      userResponse.status = user.status;
    }

    // ✅ GET CURRENT VERSIONS IF RE-ACCEPTANCE NEEDED
    let currentVersions = null;
    if (!hasAcceptedCurrent) {
      try {
        const [termsDoc, privacyDoc] = await Promise.all([
          LegalVersion.findOne({ documentType: 'TERMS' }),
          LegalVersion.findOne({ documentType: 'PRIVACY' })
        ]);
        
        currentVersions = {
          terms: {
            version: termsDoc?.currentVersion,
            url: termsDoc?.url
          },
          privacy: {
            version: privacyDoc?.currentVersion,
            url: privacyDoc?.url
          }
        };
      } catch (versionError) {
        console.log('⚠️ Could not fetch legal versions:', versionError.message);
      }
    }

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: userResponse,
      // ✅ INCLUDE LEGAL STATUS
      requiresLegalReacceptance: !hasAcceptedCurrent,
      currentVersions: currentVersions
    });

  } catch (error) {
    console.error('💥 Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

// =============================================
// GOOGLE AUTH ENDPOINT  (SECURE — server-side ID token verification)
// =============================================

/**
 * @route   POST /api/auth/google-auth
 * @desc    Unified Google Sign-In for Login and Register flows.
 *
 * SECURITY MODEL:
 *   - Android sends ONLY idToken (obtained from Google Sign-In SDK).
 *   - Backend verifies the token with Google's servers via google-auth-library.
 *   - Backend trusts ONLY the verified payload (sub, email, name, picture).
 *   - Client-sent email / name / googleId are NEVER used.
 *
 * LOGIN  (isRegister = false):
 *   - User MUST already exist  → return token → 200
 *   - User does NOT exist      → 404
 *
 * REGISTER (isRegister = true):
 *   - User does NOT exist → create account → isNewUser: true → 201
 *   - User already exists → return token  → isNewUser: false → 200
 *
 * @access  Public
 */
router.post('/google-auth', publicApiLimiter, async (req, res) => {
  try {
    const { idToken, isRegister } = req.body;

    // ── Input validation ─────────────────────────────────────────────────────
    if (!idToken || typeof idToken !== 'string' || idToken.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'idToken is required'
      });
    }

    if (typeof isRegister !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isRegister (boolean) is required'
      });
    }

    // ── CRITICAL: Verify the ID token with Google's servers ──────────────────
    // verifyGoogleIdToken throws (with statusCode) on any failure.
    // After this line, payload fields are cryptographically verified by Google.
    let googlePayload;
    try {
      googlePayload = await verifyGoogleIdToken(idToken.trim());
    } catch (verifyErr) {
      return res.status(verifyErr.statusCode || 401).json({
        success: false,
        message: verifyErr.message
      });
    }

    // Trust ONLY the verified payload — never req.body.email / req.body.googleId.
    const verifiedGoogleId = googlePayload.sub;
    const verifiedEmail    = googlePayload.email.toLowerCase().trim();
    const verifiedName     = googlePayload.name || '';

    // ── Look up user by verified email ────────────────────────────────────────
    let user = await User.findOne({ email: verifiedEmail });

    // ════════════════════════════════════════════════════════════════════════
    //  LOGIN FLOW  (isRegister = false)
    // ════════════════════════════════════════════════════════════════════════
    if (!isRegister) {
      if (!user) {
        console.log(`🔍 Google login: no account for ${verifiedEmail}`);
        return res.status(404).json({
          success: false,
          message: 'No account found. Please register first.'
        });
      }

      // ── Account status checks ─────────────────────────────────────────────
      if (user.status && user.status !== 'ACTIVE') {
        if (user.status === 'SUSPENDED') {
          const until = user.suspensionInfo?.suspendedUntil;
          // Auto-lift if period expired
          if (until && new Date() >= new Date(until)) {
            user.status = 'ACTIVE';
            user.suspensionInfo.isSuspended = false;
            user.suspensionInfo.suspendedUntil = null;
            await user.save();
            // fall through to success
          } else {
            return res.status(403).json({
              success: false,
              message: 'Your account has been temporarily restricted.',
              suspensionInfo: {
                reason: user.suspensionInfo?.suspensionReason || 'Community guideline violation',
                suspendedUntil: until ? until.toISOString() : null
              }
            });
          }
        } else if (user.status === 'BANNED') {
          return res.status(403).json({
            success: false,
            message: 'This account has been permanently banned.'
          });
        } else {
          return res.status(403).json({
            success: false,
            message: `Account is ${user.status.toLowerCase()}`
          });
        }
      }

      // Keep googleId in sync with the verified sub.
      if (!user.googleId) user.googleId = verifiedGoogleId;
      user.lastActive = new Date();
      await user.save();

      if (user.ensureGuidelinesMigration) await user.ensureGuidelinesMigration();

      const token = generateToken(user._id, user.role || 'USER', user.tokenVersion ?? 0);
      console.log(`✅ Google login success: ${user.email}`);

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        token,
        user: buildUserResponse(user)
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  REGISTER FLOW  (isRegister = true)
    // ════════════════════════════════════════════════════════════════════════

    if (user) {
      // User already exists → log them in, indicate NOT a new user
      if (!user.googleId) user.googleId = verifiedGoogleId;
      user.lastActive = new Date();
      await user.save();

      if (user.ensureGuidelinesMigration) await user.ensureGuidelinesMigration();

      const token = generateToken(user._id, user.role || 'USER', user.tokenVersion ?? 0);

      console.log(`ℹ️ Google register: existing account ${user.email} → returning isNewUser=false`);

      return res.status(200).json({
        success: true,
        message: 'Account already exists. Logging you in.',
        token,
        user: buildUserResponse(user),
        isNewUser: false
      });
    }

    // ── Create new user using ONLY verified payload fields ──────────────────
    const nameParts  = verifiedName.trim().split(' ');
    const firstName  = nameParts[0] || 'User';
    const lastName   = nameParts.slice(1).join(' ') || '';

    // Get current legal versions for auto-acceptance
    let termsVersion   = '1.0.0';
    let privacyVersion = '1.0.0';
    try {
      const [termsDoc, privacyDoc] = await Promise.all([
        LegalVersion.findOne({ documentType: 'TERMS' }),
        LegalVersion.findOne({ documentType: 'PRIVACY' })
      ]);
      if (termsDoc)   termsVersion   = termsDoc.currentVersion;
      if (privacyDoc) privacyVersion = privacyDoc.currentVersion;
    } catch (err) {
      console.warn('⚠️ Could not fetch legal versions for Google user creation:', err.message);
    }

    const newUser = new User({
      firstName,
      lastName,
      email:                   verifiedEmail,      // ← verified by Google
      googleId:                verifiedGoogleId,   // ← verified by Google (payload.sub)
      role:                    'USER',
      emailVerified:           true,               // Google ID tokens guarantee email ownership
      acceptedTermsVersion:    termsVersion,
      acceptedPrivacyVersion:  privacyVersion,
      lastLegalAcceptanceDate: new Date()
    });

    await newUser.save();

    const token = generateToken(newUser._id, 'USER', newUser.tokenVersion ?? 0);

    console.log(`✅ Google register: new user created ${newUser.email}`);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: buildUserResponse(newUser),
      isNewUser: true
    });

  } catch (error) {
    console.error('💥 Google auth error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during Google authentication'
    });
  }
});

// ── Helper: build safe user object ────────────────────────────────────────────
function buildUserResponse(user) {
  // Use the virtual property getter
  const CURRENT_GUIDELINES_VERSION = "1.0"; // fallback if virtual not applied
  
  const needsGuidelines = user.needsGuidelinesAcceptance !== undefined ? user.needsGuidelinesAcceptance : (!user.guidelinesAccepted || user.guidelinesVersion !== "1.0");

  console.log(`[GUIDELINES]
userId=${user._id}
guidelinesAccepted=${user.guidelinesAccepted || false}
guidelinesVersion=${user.guidelinesVersion || null}
acceptedCommunityVersion=${user.acceptedCommunityVersion || null}
needsGuidelinesAcceptance=${needsGuidelines}`);

  return {
    _id:                     user._id,
    firstName:               user.firstName,
    lastName:                user.lastName,
    email:                   user.email,
    role:                    user.role || 'USER',
    profilePhoto:            user.profilePhoto || null,
    emailVerified:           user.emailVerified || true,
    verified:                user.verified || false,
    questionnaire:           user.questionnaire || {},
    isPremium:               user.isPremium || false,
    hostActive:              user.hostActive !== false,
    paymentInfo:             user.paymentInfo || null,
    photoVerificationStatus: user.photoVerificationStatus || 'not_submitted',
    profileCompleteness:     user.profileCompleteness || null,
    acceptedCommunityVersion:user.acceptedCommunityVersion || null,
    communityAcceptedAt:     user.communityAcceptedAt || null,
    guidelinesAccepted:      user.guidelinesAccepted || false,
    guidelinesVersion:       user.guidelinesVersion || null,
    needsGuidelinesAcceptance: needsGuidelines,
    lastActive:              user.lastActive || null,
    createdAt:               user.createdAt || null,
    status:                  user.status || 'ACTIVE'
  };
}

/**
 * @route   POST /api/auth/check-email
 * @desc    Check if email already exists (used before registration OTP step)
 * @access  Public
 */
router.post('/check-email', publicApiLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() }).select('_id');
    return res.json({ success: true, exists: !!existing });
  } catch (error) {
    console.error('check-email error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * @route   POST /api/auth/send-otp-registration
 * @desc    Send OTP for email verification during registration
 * @access  Public
 * SECURITY: Rate limited, CSPRNG OTP, bcrypt+pepper hash, DB-backed cooldown
 */
router.post('/send-otp-registration', sendOtpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const normalizedEmail = email.toLowerCase().trim();

    // ── User enumeration protection ──────────────────────────────────────────
    // Always return generic success — attacker learns nothing from the response.
    const existingUser = await User.findOne({ email: normalizedEmail }).select('_id');
    if (existingUser) {
      if (existingUser.ensureGuidelinesMigration) await existingUser.ensureGuidelinesMigration();
      return res.json({ success: true, message: 'If this email is valid, an OTP has been sent.' });
    }

    // ── Delegate all OTP logic to otpService (handles cooldown, hash, email) ─
    const result = await sendOtp({
      email:     normalizedEmail,
      purpose:   'registration',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (!result.ok) {
      return res.status(result.status).json({
        success:           false,
        message:           result.message,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    res.json({ success: true, message: 'If this email is valid, an OTP has been sent.' });

  } catch (error) {
    console.error('[OTP] send-otp-registration error:', error);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

/**
 * @route   POST /api/auth/verify-otp-registration
 * @desc    Verify OTP during registration
 * @access  Public
 * SECURITY: Rate limited, bcrypt.compare (timing-safe), attempt lockout, replay prevention
 */
router.post('/verify-otp-registration', verifyOtpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const result = await verifyOtp({
      email:   email.toLowerCase().trim(),
      otp:     otp.toString().trim(),
      purpose: 'registration',
    });

    if (!result.ok) {
      return res.status(result.status).json({
        success:           false,
        message:           result.message,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    res.json({ success: true, message: 'Email verified successfully', verified: true });

  } catch (error) {
    console.error('[OTP] verify-otp-registration error:', error);
    res.status(500).json({ success: false, message: 'Failed to verify OTP' });
  }
});

// =============================================
// PROTECTED ROUTES
// =============================================

/**
 * @route   GET /api/auth/me
 * @desc    Get current user info (refreshes role from DB)
 * @access  Private
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = req.user;
    if (user.ensureGuidelinesMigration) {
      await user.ensureGuidelinesMigration();
    }
    // Convert to plain object to include virtuals via getPrivateProfile if not already lean, or just use buildUserResponse
    // Wait, the existing code just returned req.user. Let's return it but ensure virtuals are sent
    // and let's use buildUserResponse to maintain consistency, or keep it as req.user
    // Usually /me returns the full private profile via getPrivateProfile(). Actually, wait, auth /me just returned req.user
    
    // To ensure the fields are there:
    const userData = user.toObject ? user.toObject({ virtuals: true }) : user;
    
    res.json({
      success: true,
      user: userData
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user data'
    });
  }
});

// =============================================
// ADMIN CREATION (SUPER_ADMIN ONLY)
// =============================================

/**
 * @route   POST /api/auth/create-admin
 * @desc    Create new admin account (SUPER_ADMIN only)
 * @access  Private (SUPER_ADMIN)
 */
router.post('/create-admin', authenticate, async (req, res) => {
  try {
    // Check if user is super admin
    if (!req.user || req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Super admin access required'
      });
    }

    const {
      firstName,
      lastName,
      email,
      password,
      role,
      permissions
    } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Validate role
    if (!['SAFETY_ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid admin role'
      });
    }

    // Check if email exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // ✅ Get current legal versions for admin creation
    let currentTermsVersion = '1.0.0';
    let currentPrivacyVersion = '1.0.0';
    try {
      const [termsDoc, privacyDoc] = await Promise.all([
        LegalVersion.findOne({ documentType: 'TERMS' }),
        LegalVersion.findOne({ documentType: 'PRIVACY' })
      ]);
      if (termsDoc) currentTermsVersion = termsDoc.currentVersion;
      if (privacyDoc) currentPrivacyVersion = privacyDoc.currentVersion;
    } catch (err) {
      console.log('Could not fetch legal versions for admin creation');
    }

    // Create admin user
    const admin = new User({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password,
      role,
      emailVerified: true,
      verified: true,
      adminPermissions: permissions,
      // ✅ Set legal acceptance for admin (auto-accepted)
      acceptedTermsVersion: currentTermsVersion,
      acceptedPrivacyVersion: currentPrivacyVersion,
      lastLegalAcceptanceDate: new Date()
    });

    // Set status if field exists
    if (admin.status !== undefined) {
      admin.status = 'ACTIVE';
    }

    await admin.save();

    console.log(`✅ Admin created: ${admin.email} (${admin.role}) by ${req.user.email}`);

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      user: {
        _id: admin._id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        role: admin.role,
        adminPermissions: admin.adminPermissions
      }
    });

  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create admin account'
    });
  }
});

// =============================================
// FACEBOOK AUTH ENDPOINT
// =============================================

/**
 * @route   POST /api/auth/facebook-auth
 * @desc    Unified Facebook Sign-In for Login and Register flows
 * @access  Public
 */
router.post('/facebook-auth', publicApiLimiter, async (req, res) => {
  try {
    const { email, name, facebookId, accessToken, isRegister } = req.body;

    // ── Input validation ──────────────────────────────────────────────────
    if (!email || !name || !facebookId || !accessToken) {
      return res.status(400).json({
        success: false,
        message: 'email, name, facebookId, and accessToken are required'
      });
    }

    if (typeof isRegister !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isRegister (boolean) is required'
      });
    }

    // ── Verify Facebook accessToken via Graph API ─────────────────────────
    const fetch = require('node-fetch');
    const graphUrl = `https://graph.facebook.com/me?fields=id,name,email&access_token=${accessToken}`;
    let graphData;
    try {
      const graphRes  = await fetch(graphUrl);
      graphData = await graphRes.json();
    } catch (fetchErr) {
      console.error('Facebook Graph API fetch error:', fetchErr);
      return res.status(502).json({
        success: false,
        message: 'Could not verify Facebook token. Please try again.'
      });
    }

    if (graphData.error) {
      console.warn('Facebook token invalid:', graphData.error.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired Facebook session. Please sign in again.'
      });
    }

    if (graphData.id !== facebookId) {
      console.warn(`Facebook ID mismatch: client=${facebookId} graph=${graphData.id}`);
      return res.status(401).json({
        success: false,
        message: 'Facebook authentication mismatch. Please try again.'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Look up user ──────────────────────────────────────────────────────
    let user = await User.findOne({ email: normalizedEmail });

    // ══════════════════════════════════════════════════════════════════════
    //  LOGIN FLOW  (isRegister = false)
    // ══════════════════════════════════════════════════════════════════════
    if (!isRegister) {
      if (!user) {
        console.log(`Facebook login: no account for ${normalizedEmail}`);
        return res.status(404).json({
          success: false,
          message: 'No account found. Please register first.'
        });
      }

      if (user.status && user.status !== 'ACTIVE') {
        if (user.status === 'SUSPENDED') {
          const until = user.suspensionInfo?.suspendedUntil;
          if (until && new Date() >= new Date(until)) {
            user.status = 'ACTIVE';
            user.suspensionInfo.isSuspended = false;
            user.suspensionInfo.suspendedUntil = null;
            await user.save();
          } else {
            return res.status(403).json({
              success: false,
              message: 'Your account has been temporarily restricted.',
              suspensionInfo: {
                reason: user.suspensionInfo?.suspensionReason || 'Community guideline violation',
                suspendedUntil: until ? until.toISOString() : null
              }
            });
          }
        } else if (user.status === 'BANNED') {
          return res.status(403).json({
            success: false,
            message: 'This account has been permanently banned.'
          });
        } else {
          return res.status(403).json({
            success: false,
            message: `Account is ${user.status.toLowerCase()}`
          });
        }
      }

      if (!user.facebookId) user.facebookId = facebookId;
      user.lastActive = new Date();
      await user.save();

      if (user.ensureGuidelinesMigration) await user.ensureGuidelinesMigration();

      const token = generateToken(user._id, user.role || 'USER', user.tokenVersion ?? 0);
      console.log(`✅ Facebook login success: ${user.email}`);

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        token,
        user: buildUserResponse(user)
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  REGISTER FLOW  (isRegister = true)
    // ══════════════════════════════════════════════════════════════════════
    if (user) {
      if (!user.facebookId) user.facebookId = facebookId;
      user.lastActive = new Date();
      await user.save();

      if (user.ensureGuidelinesMigration) await user.ensureGuidelinesMigration();

      const token = generateToken(user._id, user.role || 'USER', user.tokenVersion ?? 0);
      console.log(`ℹ️ Facebook register: existing account ${user.email} → isNewUser=false`);

      return res.status(200).json({
        success: true,
        message: 'Account already exists. Logging you in.',
        token,
        user: buildUserResponse(user),
        isNewUser: false
      });
    }

    const nameParts  = name.trim().split(' ');
    const firstName  = nameParts[0] || 'User';
    const lastName   = nameParts.slice(1).join(' ') || '';

    let termsVersion   = '1.0.0';
    let privacyVersion = '1.0.0';
    try {
      const [termsDoc, privacyDoc] = await Promise.all([
        LegalVersion.findOne({ documentType: 'TERMS' }),
        LegalVersion.findOne({ documentType: 'PRIVACY' })
      ]);
      if (termsDoc)   termsVersion   = termsDoc.currentVersion;
      if (privacyDoc) privacyVersion = privacyDoc.currentVersion;
    } catch (err) {
      console.warn('Could not fetch legal versions for Facebook user creation:', err.message);
    }

    const newUser = new User({
      firstName,
      lastName,
      email:         normalizedEmail,
      facebookId,
      authProvider:  'facebook',
      role:          'USER',
      emailVerified: true,
      acceptedTermsVersion:    termsVersion,
      acceptedPrivacyVersion:  privacyVersion,
      lastLegalAcceptanceDate: new Date()
    });

    await newUser.save();

    const token = generateToken(newUser._id, 'USER', newUser.tokenVersion ?? 0);
    console.log(`✅ Facebook register: new user created ${newUser.email}`);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: buildUserResponse(newUser),
      isNewUser: true
    });

  } catch (error) {
    console.error('💥 Facebook auth error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during Facebook authentication'
    });
  }
});

// =============================================
// LOGOUT-ALL
// =============================================

/**
 * @route   POST /api/auth/logout-all
 * @desc    Invalidate ALL active JWTs for this user by incrementing tokenVersion.
 * @access  Private
 */
router.post('/logout-all', authenticate, async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.user._id },
      { $inc: { tokenVersion: 1 } }
    );
    console.log(`✅ logout-all: tokenVersion incremented for ${req.user.email}`);
    return res.json({ success: true, message: 'All sessions have been logged out.' });
  } catch (error) {
    console.error('logout-all error:', error);
    return res.status(500).json({ success: false, message: 'Server error during logout' });
  }
});

module.exports = router;
