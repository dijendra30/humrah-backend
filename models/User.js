// models/User.js - UPDATED with MEMBER/COMPANION + LOCATION + COMMUNITY GUIDELINES ACCEPTANCE
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// =============================================
// QUESTIONNAIRE SCHEMA
// =============================================
const questionnaireSchema = new mongoose.Schema({
  name: String,
  city: String,
  languagePreference: String,
  hangoutPreferences: [String],
  availableTimes: [String],
  meetupPreference: String,
  lookingForOnHumrah: [String],
  vibeWords: [String],
  publicPlacesOnly: String,
  ageGroup: String,
  state: String,
  area: String,
  bio: String,
  goodMeetupMeaning: String,
  vibeQuote: String,
  comfortActivity: [String],
  relaxActivity: [String],
  musicPreference: [String],
  budgetComfort: String,
  comfortZones: [String],
  hangoutFrequency: String,
  becomeCompanion: String,
  openFor: [String],
  availability: String,
  price: String,
  tagline: String,
  verifyIdentity: String,
  understandGuidelines: String,
  mood: String,
  personalityType: String,
  gender: String,
  dateOfBirth: String,
  language: String,
  interests: [String],
  hobbies: [String],
  movieGenre: String,
  favoriteFood: String,
  travelPreference: String,
  petPreference: String,
  fitnessLevel: String,
  smokingStatus: String,
  drinkingStatus: String,
  relationshipStatus: String,
  lookingFor: String,
  connectAndEarn: String,
  profession: String,
  education: String,
  income: String
}, { _id: false });

// =============================================
// USER SCHEMA
// =============================================
const userSchema = new mongoose.Schema({

  // ── Basic Information ──────────────────────
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: function () {
      return !this.googleId && !this.facebookId;
    },
    minlength: [6, 'Password must be at least 6 characters']
  },

  // =============================================
  // ✅ TERMS & PRIVACY ACCEPTANCE
  // =============================================
  acceptedTermsVersion: {
    type: String,
    default: null
  },

  acceptedPrivacyVersion: {
    type: String,
    default: null
  },

  lastLegalAcceptanceDate: {
    type: Date,
    default: null
  },

  requiresLegalReacceptance: {
    type: Boolean,
    default: false
  },

  // =============================================
  // ✅ COMMUNITY GUIDELINES ACCEPTANCE (NEW)
  //
  // How versioning works:
  //   1. Set COMMUNITY_GUIDELINES_VERSION=1.0 in your .env
  //   2. When you update guidelines, bump it to 1.1, 2.0 etc.
  //   3. enforceCommunityAcceptance middleware will block all
  //      protected routes for users whose acceptedCommunityVersion
  //      does not match the env var — no DB migration needed.
  //   4. Android client sends ANDROID_ID as deviceFingerprint.
  //   5. acceptedCommunityVersion + communityAcceptedAt are returned
  //      in getPrivateProfile() so the Android app can pre-fill the
  //      checkbox without an extra API call.
  // =============================================
  acceptedCommunityVersion: {
    type: String,
    default: null,
    index: true
  },

  communityAcceptedAt: {
    type: Date,
    default: null
  },

  communityAcceptedIP: {
    type: String,
    default: null
  },

  communityAcceptedDevice: {
    type: String,
    default: null
  },

  // =============================================
  // ✅ SAFETY & CONSENT LOGS
  // =============================================

  safetyDisclaimerAcceptances: [{
    acceptedAt: Date,
    bookingId: mongoose.Schema.Types.ObjectId,
    ipAddress: String
  }],

  videoVerificationConsents: [{
    acceptedAt: Date,
    sessionId: String,
    ipAddress: String
  }],

  // GDPR deletion tracking
  deletionRequestedAt: {
    type: Date,
    default: null
  },

  // =============================================
  // ✅ USER TYPE SYSTEM
  // =============================================
  userType: {
    type: String,
    enum: ['MEMBER', 'COMPANION'],
    default: 'MEMBER',
    index: true
  },

  role: {
    type: String,
    enum: ['USER', 'SAFETY_ADMIN', 'SUPER_ADMIN'],
    default: 'USER',
    required: true,
    index: true
  },

  // PENDING_DELETION added to support /api/legal/request-deletion (GDPR)
  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_VERIFICATION', 'PENDING_DELETION'],
    default: 'ACTIVE',
    index: true
  },

  // =============================================
  // ✅ LOCATION FIELDS (Privacy-Safe)
  // =============================================
  last_known_lat: {
    type: Number,
    default: null
  },
  last_known_lng: {
    type: Number,
    default: null
  },
  last_location_updated_at: {
    type: Date,
    default: null,
    index: true
  },

  // =============================================
  // ✅ VIDEO VERIFICATION FIELDS
  // =============================================
  verificationEmbedding: {
    type: [Number],
    default: null
  },

  verifiedAt: {
    type: Date,
    default: null
  },

  verificationType: {
    type: String,
    enum: ['PHOTO', 'VIDEO', 'MANUAL', null],
    default: null
  },

  verificationAttempts: {
    type: Number,
    default: 0
  },

  lastVerificationAttempt: {
    type: Date,
    default: null
  },

  verificationRejections: {
    type: [{
      reason: String,
      rejectedAt: Date,
      sessionId: String
    }],
    default: []
  },

  // ── Payment Info ───────────────────────────
  paymentInfo: {
    upiId: { type: String, default: null },
    upiName: { type: String, default: null },
    upiStatus: {
      type: String,
      enum: ['not_set', 'pending_verification', 'verified', 'failed'],
      default: 'not_set'
    },
    upiVerifiedAt: { type: Date, default: null },
    upiLastUpdated: { type: Date, default: null },
    upiVerificationAttempts: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    verificationPhoto: { type: String, default: null },
    verificationPhotoPublicId: { type: String, default: null },
    photoVerificationStatus: {
      type: String,
      enum: ['not_submitted', 'pending', 'approved', 'rejected'],
      default: 'not_submitted'
    },
    pendingPayout: { type: Number, default: 0 },
    completedPayouts: { type: Number, default: 0 },
    lastPayoutDate: { type: Date, default: null },
    bankAccount: {
      accountNumber: String,
      ifscCode: String,
      accountHolderName: String,
      isVerified: { type: Boolean, default: false }
    }
  },

  ratingStats: {
    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    totalRatings: { type: Number, default: 0 },
    completedBookings: { type: Number, default: 0 },
    starDistribution: {
      five:  { type: Number, default: 0 },
      four:  { type: Number, default: 0 },
      three: { type: Number, default: 0 },
      two:   { type: Number, default: 0 },
      one:   { type: Number, default: 0 }
    }
  },

  profileEditStats: {
    lastPhotoUpdate:    { type: Date, default: null },
    lastBioUpdate:      { type: Date, default: null },
    lastAgeGroupUpdate: { type: Date, default: null },
    totalEdits:         { type: Number, default: 0 }
  },

  profilePhoto:         { type: String, default: null },
  profilePhotoPublicId: { type: String, default: null },

  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },

  verified:      { type: Boolean, default: false },
  emailVerified: { type: Boolean, default: false },

  verificationPhoto:            { type: String, default: null },
  verificationPhotoPublicId:    { type: String, default: null },
  photoVerificationStatus: {
    type: String,
    enum: ['not_submitted', 'pending', 'approved', 'rejected'],
    default: 'not_submitted'
  },
  verificationPhotoSubmittedAt: { type: Date, default: null },
  photoVerifiedAt:              { type: Date, default: null },
  photoVerifiedBy:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  photoRejectionReason:         { type: String, default: null },

  emailVerificationOTP:     { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },

  googleId:   String,
  facebookId: String,

  fcmTokens: {
    type: [String],
    default: []
  },

  isPremium:        { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },

  lastActive: { type: Date, default: Date.now },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now }

}, { timestamps: true });

// =============================================
// ✅ INDEXES
// =============================================
userSchema.index({ last_known_lat: 1, last_known_lng: 1 });
userSchema.index({ last_location_updated_at: 1 });
userSchema.index({ acceptedCommunityVersion: 1 });  // fast enforcement checks

// =============================================
// ✅ PRE-SAVE HOOKS
// =============================================

// Auto-update userType based on becomeCompanion answer
userSchema.pre('save', function (next) {
  if (this.questionnaire && this.questionnaire.becomeCompanion) {
    this.userType = this.questionnaire.becomeCompanion === "Yes, I'm interested"
      ? 'COMPANION'
      : 'MEMBER';
  }
  next();
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// =============================================
// ✅ TERMS & PRIVACY METHODS
// =============================================

/**
 * Check if user has accepted current Terms & Privacy versions.
 * Called by enforceLegalAcceptance middleware on every protected request.
 */
userSchema.methods.hasAcceptedCurrentLegal = async function () {
  const LegalVersion = mongoose.model('LegalVersion');
  const [termsDoc, privacyDoc] = await Promise.all([
    LegalVersion.findOne({ documentType: 'TERMS' }),
    LegalVersion.findOne({ documentType: 'PRIVACY' })
  ]);
  if (!termsDoc || !privacyDoc) throw new Error('Legal versions not configured');
  return (
    this.acceptedTermsVersion    === termsDoc.currentVersion &&
    this.acceptedPrivacyVersion  === privacyDoc.currentVersion &&
    !this.requiresLegalReacceptance
  );
};

// =============================================
// ✅ COMMUNITY GUIDELINES METHODS
// =============================================

/**
 * Check if user has accepted the current Community Guidelines version.
 * Reads from COMMUNITY_GUIDELINES_VERSION env var — bump to force re-acceptance.
 * Called by enforceCommunityAcceptance middleware.
 */
userSchema.methods.hasAcceptedCurrentCommunityGuidelines = function () {
  const currentVersion = process.env.COMMUNITY_GUIDELINES_VERSION || '1.0';
  return this.acceptedCommunityVersion === currentVersion;
};

/**
 * Persist community guidelines acceptance.
 * Called by POST /api/legal/community/accept after version validation.
 *
 * @param {string} version           - version string from client (e.g. '1.0')
 * @param {string} ipAddress         - real IP (x-forwarded-for or req.ip)
 * @param {string} deviceFingerprint - ANDROID_ID from Android client
 */
userSchema.methods.acceptCommunityGuidelines = async function (version, ipAddress, deviceFingerprint) {
  this.acceptedCommunityVersion = version;
  this.communityAcceptedAt      = new Date();
  this.communityAcceptedIP      = ipAddress;
  this.communityAcceptedDevice  = deviceFingerprint;
  return this.save();
};

// =============================================
// ✅ SAFETY & CONSENT LOG METHODS
// =============================================

userSchema.methods.logSafetyDisclaimer = function (bookingId, ipAddress) {
  this.safetyDisclaimerAcceptances.push({ acceptedAt: new Date(), bookingId, ipAddress });
  if (this.safetyDisclaimerAcceptances.length > 100) {
    this.safetyDisclaimerAcceptances = this.safetyDisclaimerAcceptances.slice(-100);
  }
  return this.save();
};

userSchema.methods.logVideoConsent = function (sessionId, ipAddress) {
  this.videoVerificationConsents.push({ acceptedAt: new Date(), sessionId, ipAddress });
  if (this.videoVerificationConsents.length > 10) {
    this.videoVerificationConsents = this.videoVerificationConsents.slice(-10);
  }
  return this.save();
};

// =============================================
// ✅ VERIFICATION METHODS
// =============================================

userSchema.methods.canAttemptVerification = function () {
  if (!this.lastVerificationAttempt) return true;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (this.lastVerificationAttempt < oneHourAgo) return true;
  if (this.verificationAttempts < 3) return true;
  return false;
};

userSchema.methods.recordVerificationAttempt = async function () {
  this.verificationAttempts += 1;
  this.lastVerificationAttempt = new Date();
  return await this.save();
};

userSchema.methods.recordVerificationRejection = async function (reason, sessionId) {
  this.verificationRejections.push({ reason, rejectedAt: new Date(), sessionId });
  if (this.verificationRejections.length > 5) {
    this.verificationRejections = this.verificationRejections.slice(-5);
  }
  return await this.save();
};

userSchema.methods.markVerifiedViaVideo = async function (embedding) {
  this.verified = true;
  this.verifiedAt = new Date();
  this.verificationType = 'VIDEO';
  this.verificationEmbedding = embedding;
  this.photoVerificationStatus = 'approved';
  return await this.save();
};

// =============================================
// ✅ LOCATION METHODS
// =============================================

userSchema.methods.updateLocation = function (lat, lng) {
  this.last_known_lat = lat;
  this.last_known_lng = lng;
  this.last_location_updated_at = new Date();
};

userSchema.methods.hasRecentLocation = function () {
  if (!this.last_location_updated_at) return false;
  const hoursSinceUpdate = (Date.now() - this.last_location_updated_at.getTime()) / (1000 * 60 * 60);
  return hoursSinceUpdate < 24;
};

userSchema.methods.getLocationForMatching = function () {
  if (!this.hasRecentLocation()) return null;
  return {
    lat: this.last_known_lat,
    lng: this.last_known_lng,
    updatedAt: this.last_location_updated_at
  };
};

// =============================================
// ✅ USER TYPE METHODS
// =============================================

userSchema.methods.isCompanion = function () { return this.userType === 'COMPANION'; };
userSchema.methods.isMember    = function () { return this.userType === 'MEMBER'; };

// =============================================
// ✅ PASSWORD METHODS
// =============================================

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.isFullyVerified = function () {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};

// =============================================
// ✅ PROFILE METHODS
// =============================================

userSchema.methods.getPublicProfile = function () {
  return {
    _id: this._id,
    firstName: this.firstName,
    lastName: this.lastName,
    profilePhoto: this.profilePhoto,
    verified: this.verified,
    isPremium: this.isPremium,
    userType: this.userType,
    questionnaire: {
      city: this.questionnaire?.city,
      interests: this.questionnaire?.interests,
      ageGroup: this.questionnaire?.ageGroup,
      state: this.questionnaire?.state,
      area: this.questionnaire?.area,
      bio: this.questionnaire?.bio,
      ...(this.userType === 'COMPANION' && {
        becomeCompanion: this.questionnaire?.becomeCompanion,
        openFor:         this.questionnaire?.openFor,
        availability:    this.questionnaire?.availability,
        price:           this.questionnaire?.price,
        tagline:         this.questionnaire?.tagline
      })
    },
    ...(this.userType === 'COMPANION' && { ratingStats: this.ratingStats })
  };
};

/**
 * getPrivateProfile includes acceptedCommunityVersion + communityAcceptedAt
 * so the Android client can pre-fill the checkbox on the Trust & Safety section.
 * IP and device fingerprint are NEVER returned to the client.
 */
userSchema.methods.getPrivateProfile = function () {
  return {
    _id: this._id,
    firstName: this.firstName,
    lastName: this.lastName,
    email: this.email,
    profilePhoto: this.profilePhoto,
    verified: this.verified,
    emailVerified: this.emailVerified,
    isPremium: this.isPremium,
    premiumExpiresAt: this.premiumExpiresAt,
    role: this.role,
    userType: this.userType,
    verificationPhoto: this.verificationPhoto,
    photoVerificationStatus: this.photoVerificationStatus,
    questionnaire: this.questionnaire,
    paymentInfo: this.paymentInfo,
    ratingStats: this.ratingStats,
    profileEditStats: this.profileEditStats,
    // ✅ Community guidelines status for Android checkbox pre-fill
    acceptedCommunityVersion: this.acceptedCommunityVersion,
    communityAcceptedAt: this.communityAcceptedAt,
    // Location
    last_known_lat: this.last_known_lat,
    last_known_lng: this.last_known_lng,
    last_location_updated_at: this.last_location_updated_at,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    lastActive: this.lastActive
  };
};

module.exports = mongoose.model('User', userSchema);
