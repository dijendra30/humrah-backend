// models/User.js - UPDATED with MEMBER/COMPANION User Type System + LOCATION SUPPORT + LIVE LOCATION
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const CURRENT_GUIDELINES_VERSION = "1.0";



// Questionnaire schema (existing, no changes)
const questionnaireSchema = new mongoose.Schema({
  name: String,
  city: String,
  // ── Language preference ────────────────────────────────────────────────────
  // preferredLanguages is the canonical multi-select field (new clients).
  // languagePreference is the legacy single-string field kept for backward
  // compat. On first save by a new client, preferredLanguages is written
  // and languagePreference is left as-is (or null). The migration script
  // scripts/migrateLanguageField.js back-fills preferredLanguages for all
  // existing users that only have languagePreference set.
  preferredLanguages: [String],
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
  costSharingPreference: {
    type: String,
    enum: [
      'FREE_ONLY',
      'SPLIT_FAIRLY',
      'DEPENDS_ON_ACTIVITY',
      'HOST_COVERS',
      'DISCUSS_FIRST'
    ],
    default: null
  },
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
  income: String,
  // =============================================
  // ONBOARDING & COMPLIANCE FIELDS
  // =============================================
  dateOfBirth: String,
  age: Number,
  ageGroup: String,
  isAdultConfirmed: { type: Boolean, default: false },
  consentAccepted: { type: Boolean, default: false },
  consentTimestamp: { type: Date, default: null }
}, { _id: false });

const userSchema = new mongoose.Schema({
  // =============================================
  // MODERATION TRACKING
  // =============================================
  moderationStatus: {
    type: String,
    enum: ['clean', 'pending_review', 'flagged'],
    default: 'clean'
  },
  flaggedFields: [{
    type: String
  }],

  // Basic Information
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
  // PASSWORD RESET SECURITY FIELDS
  // =============================================
  lastPasswordResetAt: {
    type: Date,
    default: null,
    select: false
  },
  resetPasswordCount: {
    type: Number,
    default: 0,
    select: false
  },
  previousPasswords: {
    type: [String],
    default: [],
    select: false
  },

  // =============================================
  // TOKEN VERSION -- for forced logout / revocation
  // =============================================
  tokenVersion: {
    type: Number,
    default: 0,
    select: true
  },

  acceptedTermsVersion:    { type: String,  default: null },
  acceptedPrivacyVersion:  { type: String,  default: null },
  lastLegalAcceptanceDate: { type: Date,    default: null },
  requiresLegalReacceptance: { type: Boolean, default: false },

  notifications: {
    activityRequests:  { type: Boolean, default: true },
    gamingAlerts:      { type: Boolean, default: true },
    communityActivity: { type: Boolean, default: true },
    appUpdates:        { type: Boolean, default: true }
  },

  blockedUsers:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  mutedUsers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  hiddenPosts:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  savedPosts:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],

  notInterestedUsers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    score:  { type: Number, default: 1 }
  }],

  pendingEmail:           { type: String, default: null, select: false },
  pendingEmailOTP:        { type: String, default: null, select: false },
  pendingEmailOTPExpires: { type: Date,   default: null, select: false },

  acceptedCommunityVersion: { type: String, default: null }, // Legacy
  communityAcceptedAt:      { type: Date,   default: null }, // Legacy
  communityAcceptedDevice:  { type: String, default: null }, // Legacy
  communityAcceptedIP:      { type: String, default: null }, // Legacy

  guidelinesAccepted: {
    type: Boolean,
    default: false
  },
  guidelinesAcceptedAt: {
    type: Date
  },
  guidelinesVersion: {
    type: String
  },

  safetyDisclaimerAcceptances: [{ acceptedAt: Date, bookingId: mongoose.Schema.Types.ObjectId, ipAddress: String }],
  videoVerificationConsents:   [{ acceptedAt: Date, sessionId: String, ipAddress: String }],

  deletionRequestedAt: { type: Date,    default: null },
  profileBotConsent:   { type: Boolean, default: false },

  groqUsage: {
    date:  { type: String, default: null },
    count: { type: Number, default: 0 },
  },

  // =============================================
  // USER TYPE SYSTEM
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

  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_VERIFICATION'],
    default: 'ACTIVE',
    index: true
  },

  suspensionInfo: {
    isSuspended:      { type: Boolean, default: false },
    suspensionReason: { type: String,  default: null  },
    suspendedAt:      { type: Date,    default: null  },
    suspendedUntil:   { type: Date,    default: null  },
    suspendedBy:      { type: String,  default: null  },
    autoLiftAt:       { type: Date,    default: null  },
  },

  // =============================================
  // LEGACY LOCATION FIELDS (Privacy-Safe)
  // Kept for backward compat. New code should prefer liveLocation.
  // =============================================
  last_known_lat:           { type: Number, default: null },
  last_known_lng:           { type: Number, default: null },
  last_location_updated_at: { type: Date,   default: null },

  // =============================================
  // LIVE LOCATION -- Lightweight matchmaking location
  //
  // Updated ONLY on specific triggers (no background tracking):
  //   1. App opens
  //   2. App resumes after long background idle
  //   3. Surprise Meetup screen opens
  //   4. Before "Find My Match" tap
  //   5. Before creating a meetup
  //
  // profileCity (questionnaire.city) is NEVER touched here.
  // Used by: Surprise Meetup system, nearby match search.
  // Stale after 60 minutes -> frontend must refresh before matchmaking.
  // =============================================
  liveLocation: {
    lat:       { type: Number, default: null },
    lng:       { type: Number, default: null },
    city:      { type: String, default: null },  // reverse-geocoded, not profileCity
    state:     { type: String, default: null },
    updatedAt: { type: Date,   default: null },
  },

  // =============================================
  // VIDEO VERIFICATION FIELDS
  // =============================================
  verificationEmbedding:   { type: [Number], default: null },
  verifiedAt:              { type: Date,     default: null },
  verificationType:        { type: String, enum: ['PHOTO', 'VIDEO', 'MANUAL', null], default: null },
  verificationAttempts:    { type: Number,   default: 0 },
  lastVerificationAttempt: { type: Date,     default: null },
  verificationRejections:  { type: [{ reason: String, rejectedAt: Date, sessionId: String }], default: [] },

  // Payment Info
  paymentInfo: {
    upiId: { type: String, default: null },
    upiName: { type: String, default: null },
    upiStatus: { type: String, enum: ['not_set', 'pending_verification', 'verified', 'failed'], default: 'not_set' },
    upiVerifiedAt: { type: Date, default: null },
    upiLastUpdated: { type: Date, default: null },
    upiVerificationAttempts: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    verificationPhoto: { type: String, default: null },
    verificationPhotoPublicId: { type: String, default: null },
    photoVerificationStatus: { type: String, enum: ['not_submitted', 'pending', 'approved', 'rejected'], default: 'not_submitted' },
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
    averageRating:    { type: Number, default: 0, min: 0, max: 5 },
    totalRatings:     { type: Number, default: 0 },
    completedBookings:{ type: Number, default: 0 },
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

  imageStrikeCount:      { type: Number, default: 0, min: 0, max: 3 },
  imagePostBlockedUntil: { type: Date,   default: null },
  lastImageViolationAt:  { type: Date,   default: null },

  imageModerationLog: [{
    createdAt:     { type: Date, default: Date.now },
    action:        { type: String },
    blockReason:   { type: String },
    strikeCount:   { type: Number },
    safeSearch:    { type: mongoose.Schema.Types.Mixed },
    imagePublicId: { type: String, default: null }
  }],

  // =============================================
  // TIERED MODERATION FLAGS v2
  // =============================================
  moderationFlags: {
    isFlagged:   { type: Boolean, default: false },
    strikeCount: { type: Number,  default: 0 },
    violations: [{
      field:         String,
      level:         { type: Number, default: 0 },
      reason:        String,
      originalValue: String,
      cleanedValue:  String,
      categories:    [String],
      detectedAt:    { type: Date, default: Date.now },
      route:         String,
    }],
    lastViolationAt:   { type: Date,    default: null },
    autoSuspendedAt:   { type: Date,    default: null },
    restrictedUntil:   { type: Date,    default: null },
    restrictionReason: { type: String,  default: null },
    reviewedByAdmin:   { type: Boolean, default: false },
    adminReviewNote:   { type: String,  default: null },
    lastReviewedAt:    { type: Date,    default: null },
  },

  profilePhoto:        { type: String, default: null },
  profilePhotoPublicId:{ type: String, default: null },
  questionnaire:       { type: questionnaireSchema, default: {} },
  verified:            { type: Boolean, default: false },
  hostActive:          { type: Boolean, default: true },
  emailVerified:       { type: Boolean, default: false },

  verificationPhoto:                { type: String, default: null },
  verificationPhotoPublicId:        { type: String, default: null },
  photoVerificationStatus:          { type: String, enum: ['not_submitted', 'pending', 'approved', 'rejected'], default: 'not_submitted' },
  verificationPhotoSubmittedAt:     { type: Date,   default: null },
  verificationMediaDeletedAt:       { type: Date,   default: null },
  photoVerifiedAt:                  { type: Date,   default: null },
  photoVerifiedBy:                  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  photoRejectionReason:             { type: String, default: null },
  emailVerificationOTP:             { type: String, default: null },
  emailVerificationExpires:         { type: Date,   default: null },

  googleId:   String,
  facebookId: String,

  fcmTokens: { type: [String], default: [] },

  isPremium:       { type: Boolean, default: false },
  premiumExpiresAt:{ type: Date,    default: null },

  lastActive: { type: Date, default: Date.now },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },

  // =============================================
  // DEPRECATED -- do not write to these fields.
  // Mood state now lives entirely in matchingTodayMoods collection.
  // =============================================
  dailyMood: {
    moods:       { type: [String], default: [] },
    energyLevel: { type: Number,   default: null, min: 1, max: 10 },
    openTo:      { type: [String], default: [] },
    updatedAt:   { type: Date,     default: null },
    expiresAt:   { type: Date,     default: null },
    visible:     { type: Boolean,  default: true }
  },
  moodRequestsSent: { type: Map, of: Date, default: {} },

  // =============================================
  // BOOKING REFERENCES
  // =============================================
  bookingRefs: {
    type: [{
      bookingId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
      otherUserId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
      otherUserEmail: { type: String, default: null },
      status:         { type: String, enum: ['pending', 'confirmed', 'cancelled', 'completed'], default: 'pending' },
      type:           { type: String, enum: ['FREE', 'ONE_TO_ONE', 'GROUP', 'MOVIE', 'EVENT', 'SOCIAL', 'PAID'], default: 'FREE' },
      createdAt:      { type: Date, default: Date.now }
    }],
    default: []
  }

}, { timestamps: true });

userSchema.methods.isImagePostBlocked = function () {
  if (!this.imagePostBlockedUntil) return false;
  return new Date() < new Date(this.imagePostBlockedUntil);
};

// =============================================
// INDEXES
// =============================================
userSchema.index({ last_known_lat: 1, last_known_lng: 1 });
userSchema.index({ 'liveLocation.lat': 1, 'liveLocation.lng': 1 });
userSchema.index({ 'liveLocation.updatedAt': 1 });
userSchema.index({ 'liveLocation.city': 1 }); // companion city filter (live city)
userSchema.index({ 'dailyMood.expiresAt': 1, 'dailyMood.visible': 1 });
userSchema.index({ 'moderationFlags.isFlagged': 1 });
userSchema.index({ 'moderationFlags.strikeCount': 1 });
userSchema.index({ last_location_updated_at: 1 });
userSchema.index({ 'bookingRefs.bookingId': 1 });
userSchema.index({ 'bookingRefs.status': 1 });

// =============================================
// METHODS
// =============================================
userSchema.methods.canAttemptVerification = function() {
  if (!this.lastVerificationAttempt) return true;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (this.lastVerificationAttempt < oneHourAgo) return true;
  if (this.verificationAttempts < 3) return true;
  return false;
};
userSchema.methods.recordVerificationAttempt = async function() {
  this.verificationAttempts += 1;
  this.lastVerificationAttempt = new Date();
  return await this.save();
};
userSchema.methods.recordVerificationRejection = async function(reason, sessionId) {
  this.verificationRejections.push({ reason, rejectedAt: new Date(), sessionId });
  if (this.verificationRejections.length > 5) this.verificationRejections = this.verificationRejections.slice(-5);
  return await this.save();
};
userSchema.methods.markVerifiedViaVideo = async function(embedding) {
  this.verified = true;
  this.verifiedAt = new Date();
  this.verificationType = 'VIDEO';
  this.verificationEmbedding = embedding;
  this.photoVerificationStatus = 'approved';
  return await this.save();
};

userSchema.pre('save', function(next) {
  if (this.questionnaire && this.questionnaire.becomeCompanion) {
    this.userType = this.questionnaire.becomeCompanion === "Yes, I'm interested" ? 'COMPANION' : 'MEMBER';
  }
  next();
});

// Legacy location helpers -- kept for backward compat
userSchema.methods.updateLocation = function(lat, lng) {
  this.last_known_lat = lat;
  this.last_known_lng = lng;
  this.last_location_updated_at = new Date();
};
userSchema.methods.hasRecentLocation = function() {
  if (!this.last_location_updated_at) return false;
  return (Date.now() - this.last_location_updated_at.getTime()) / (1000 * 60 * 60) < 24;
};
userSchema.methods.getLocationForMatching = function() {
  if (!this.hasRecentLocation()) return null;
  return { lat: this.last_known_lat, lng: this.last_known_lng, updatedAt: this.last_location_updated_at };
};

// Live location helpers
userSchema.methods.updateLiveLocation = function(lat, lng, city = null, state = null) {
  const now = new Date();
  this.liveLocation = { lat, lng, city, state, updatedAt: now };
  this.last_known_lat           = lat;
  this.last_known_lng           = lng;
  this.last_location_updated_at = now;
};
userSchema.methods.hasFreshLiveLocation = function() {
  if (!this.liveLocation?.updatedAt) return false;
  return (Date.now() - new Date(this.liveLocation.updatedAt).getTime()) < 60 * 60 * 1000;
};
userSchema.methods.getBestLocationForMatching = function() {
  if (this.liveLocation?.lat && this.liveLocation?.lng && this.hasFreshLiveLocation()) {
    return { lat: this.liveLocation.lat, lng: this.liveLocation.lng, city: this.liveLocation.city, state: this.liveLocation.state, updatedAt: this.liveLocation.updatedAt, source: 'live' };
  }
  if (this.hasRecentLocation()) {
    return { lat: this.last_known_lat, lng: this.last_known_lng, city: null, state: null, updatedAt: this.last_location_updated_at, source: 'legacy' };
  }
  return null;
};

userSchema.methods.isCompanion = function() { return this.userType === 'COMPANION'; };
userSchema.methods.isMember    = function() { return this.userType === 'MEMBER'; };

userSchema.methods.getPublicProfile = function() {
  const profile = {
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
        openFor: this.questionnaire?.openFor,
        availability: this.questionnaire?.availability,
        price: this.questionnaire?.price,
        tagline: this.questionnaire?.tagline
      })
    },
    ...(this.userType === 'COMPANION' && { ratingStats: this.ratingStats })
  };

  // Mask flagged fields from public view
  if (this.flaggedFields && this.flaggedFields.length > 0) {
    for (const fieldPath of this.flaggedFields) {
      if (fieldPath.startsWith('questionnaire.')) {
        const key = fieldPath.split('.')[1];
        if (profile.questionnaire && profile.questionnaire[key] !== undefined) {
          profile.questionnaire[key] = '[Hidden pending review]';
        }
      } else {
        if (profile[fieldPath] !== undefined) {
          profile[fieldPath] = '[Hidden pending review]';
        }
      }
    }
  }

  return profile;
};

userSchema.methods.getPrivateProfile = function() {
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
    hostActive: this.hostActive,
    moderationStatus: this.moderationStatus,
    flaggedFields: this.flaggedFields,
    verificationPhoto: this.verificationPhoto,
    verificationPhotoPublicId: this.verificationPhotoPublicId,
    photoVerificationStatus: this.photoVerificationStatus,
    verificationPhotoSubmittedAt: this.verificationPhotoSubmittedAt,
    photoVerifiedAt: this.photoVerifiedAt,
    photoRejectionReason: this.photoRejectionReason,
    questionnaire: this.questionnaire,
    paymentInfo: this.paymentInfo,
    ratingStats: this.ratingStats,
    profileEditStats: this.profileEditStats,
    last_known_lat: this.last_known_lat,
    last_known_lng: this.last_known_lng,
    last_location_updated_at: this.last_location_updated_at,
    liveLocation: this.liveLocation,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    lastActive: this.lastActive,
    guidelinesAccepted: this.guidelinesAccepted,
    guidelinesVersion: this.guidelinesVersion,
    needsGuidelinesAcceptance: !this.guidelinesAccepted || this.guidelinesVersion !== CURRENT_GUIDELINES_VERSION
  };
};

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

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};
userSchema.methods.isFullyVerified = function() {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};
userSchema.methods.hasAcceptedCurrentLegal = async function() {
  const LegalVersion = mongoose.model('LegalVersion');
  const [termsDoc, privacyDoc] = await Promise.all([
    LegalVersion.findOne({ documentType: 'TERMS' }),
    LegalVersion.findOne({ documentType: 'PRIVACY' })
  ]);
  if (!termsDoc || !privacyDoc) throw new Error('Legal versions not configured');
  return (
    this.acceptedTermsVersion === termsDoc.currentVersion &&
    this.acceptedPrivacyVersion === privacyDoc.currentVersion &&
    !this.requiresLegalReacceptance
  );
};
userSchema.methods.acceptCommunityGuidelines = async function(version, ipAddress, deviceFingerprint) {
  this.acceptedCommunityVersion = version;
  this.communityAcceptedAt     = new Date();
  this.communityAcceptedIP     = ipAddress         || null;
  this.communityAcceptedDevice = deviceFingerprint || null;
  return this.save();
};

userSchema.methods.ensureGuidelinesMigration = async function() {
  if (this.acceptedCommunityVersion && !this.guidelinesAccepted) {
    this.guidelinesAccepted = true;
    this.guidelinesVersion = this.acceptedCommunityVersion;
    this.guidelinesAcceptedAt = this.communityAcceptedAt || new Date();
    await this.save();
  }
};
userSchema.methods.logSafetyDisclaimer = function(bookingId, ipAddress) {
  this.safetyDisclaimerAcceptances.push({ acceptedAt: new Date(), bookingId, ipAddress });
  if (this.safetyDisclaimerAcceptances.length > 100) this.safetyDisclaimerAcceptances = this.safetyDisclaimerAcceptances.slice(-100);
  return this.save();
};
userSchema.methods.logVideoConsent = function(sessionId, ipAddress) {
  this.videoVerificationConsents.push({ acceptedAt: new Date(), sessionId, ipAddress });
  if (this.videoVerificationConsents.length > 10) this.videoVerificationConsents = this.videoVerificationConsents.slice(-10);
  return this.save();
};
userSchema.methods.addModerationStrike = async function(violations, route) {
  const { applyStrikesAndEnforce } = require('./middleware/moderation');
  return applyStrikesAndEnforce(this, violations, route);
};

module.exports = mongoose.model('User', userSchema);
