// models/User.js - UPDATED with MEMBER/COMPANION User Type System + LOCATION SUPPORT
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Questionnaire schema (existing, no changes)
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

const userSchema = new mongoose.Schema({
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

// Safety disclaimer acceptance log
safetyDisclaimerAcceptances: [{
  acceptedAt: Date,
  bookingId: mongoose.Schema.Types.ObjectId,
  ipAddress: String
}],

// Video verification consent log
videoVerificationConsents: [{
  acceptedAt: Date,
  sessionId: String,
  ipAddress: String
}],

// Data deletion tracking
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
  
  // Role & Status (Admin Access)
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
  // ✅ VIDEO VERIFICATION FIELDS (NEW)
  // =============================================
  
  // Face embedding for matching
  verificationEmbedding: {
    type: [Number],
    default: null
  },
  
  // When user was verified
  verifiedAt: {
    type: Date,
    default: null
  },
  
  // Verification method used
  verificationType: {
    type: String,
    enum: ['PHOTO', 'VIDEO', 'MANUAL', null],
    default: null
  },
  
  // Number of verification attempts
  verificationAttempts: {
    type: Number,
    default: 0
  },
  
  // Last verification attempt
  lastVerificationAttempt: {
    type: Date,
    default: null
  },
  
  // Verification rejection history
  verificationRejections: {
    type: [{
      reason: String,
      rejectedAt: Date,
      sessionId: String
    }],
    default: []
  },
  
  // Payment Info
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
    default: 'not_submitted'},
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
      five: { type: Number, default: 0 },
      four: { type: Number, default: 0 },
      three: { type: Number, default: 0 },
      two: { type: Number, default: 0 },
      one: { type: Number, default: 0 }
    }
  },
  
  profileEditStats: {
    lastPhotoUpdate: { type: Date, default: null },
    lastBioUpdate: { type: Date, default: null },
    lastAgeGroupUpdate: { type: Date, default: null },
    totalEdits: { type: Number, default: 0 }
  },
  
  profilePhoto: { type: String, default: null },
  profilePhotoPublicId: { type: String, default: null },
  
  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },
  
  verified: { type: Boolean, default: false },
  emailVerified: { type: Boolean, default: false },
  
  verificationPhoto: { type: String, default: null },
  verificationPhotoPublicId: { type: String, default: null },
  photoVerificationStatus: { 
    type: String, 
    enum: ['not_submitted', 'pending', 'approved', 'rejected'],
    default: 'not_submitted'
  },
  verificationPhotoSubmittedAt: { type: Date, default: null },
  photoVerifiedAt: { type: Date, default: null },
  photoVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  photoRejectionReason: { type: String, default: null },
  
  emailVerificationOTP: { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },
  
  googleId: String,
  facebookId: String,
  
  fcmTokens: {
    type: [String],
    default: []
  },
  
  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },
  
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
  
}, { timestamps: true });

// =============================================
// ✅ INDEXES FOR PERFORMANCE
// =============================================
// Create geospatial index for location queries
userSchema.index({ last_known_lat: 1, last_known_lng: 1 });
userSchema.index({ last_location_updated_at: 1 });


/**
 * Check if user can attempt verification
 */
userSchema.methods.canAttemptVerification = function() {
  // Allow if never attempted
  if (!this.lastVerificationAttempt) return true;
  
  // Allow if last attempt was more than 1 hour ago
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (this.lastVerificationAttempt < oneHourAgo) return true;
  
  // Allow if less than 3 attempts
  if (this.verificationAttempts < 3) return true;
  
  return false;
};

/**
 * Record verification attempt
 */
userSchema.methods.recordVerificationAttempt = async function() {
  this.verificationAttempts += 1;
  this.lastVerificationAttempt = new Date();
  return await this.save();
};

/**
 * Record verification rejection
 */
userSchema.methods.recordVerificationRejection = async function(reason, sessionId) {
  this.verificationRejections.push({
    reason,
    rejectedAt: new Date(),
    sessionId
  });
  
  // Keep only last 5 rejections
  if (this.verificationRejections.length > 5) {
    this.verificationRejections = this.verificationRejections.slice(-5);
  }
  
  return await this.save();
};

/**
 * Mark user as verified via video
 */
userSchema.methods.markVerifiedViaVideo = async function(embedding) {
  this.verified = true;
  this.verifiedAt = new Date();
  this.verificationType = 'VIDEO';
  this.verificationEmbedding = embedding;
  this.photoVerificationStatus = 'approved';
  return await this.save();
};

// =============================================
// ✅ MIDDLEWARE: Auto-update userType
// =============================================
userSchema.pre('save', function(next) {
  // Update userType based on becomeCompanion answer
  if (this.questionnaire && this.questionnaire.becomeCompanion) {
    if (this.questionnaire.becomeCompanion === "Yes, I'm interested") {
      this.userType = 'COMPANION';
    } else {
      this.userType = 'MEMBER';
    }
  }
  
  next();
});

// =============================================
// ✅ LOCATION METHODS
// =============================================

/**
 * Update user location
 * 
 * @param {Number} lat - Latitude
 * @param {Number} lng - Longitude
 */
userSchema.methods.updateLocation = function(lat, lng) {
  this.last_known_lat = lat;
  this.last_known_lng = lng;
  this.last_location_updated_at = new Date();
};

/**
 * Check if location is fresh (< 24 hours old)
 * 
 * @returns {Boolean} True if location is recent
 */
userSchema.methods.hasRecentLocation = function() {
  if (!this.last_location_updated_at) return false;
  
  const hoursSinceUpdate = (Date.now() - this.last_location_updated_at.getTime()) / (1000 * 60 * 60);
  return hoursSinceUpdate < 24;
};

/**
 * Get location for matching (null if too old)
 * 
 * @returns {Object|null} Location object or null
 */
userSchema.methods.getLocationForMatching = function() {
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

/**
 * Check if user is a companion
 */
userSchema.methods.isCompanion = function() {
  return this.userType === 'COMPANION';
};

/**
 * Check if user is a member
 */
userSchema.methods.isMember = function() {
  return this.userType === 'MEMBER';
};

// =============================================
// ✅ PROFILE METHODS
// =============================================

/**
 * Get public profile (for other users to view)
 */
userSchema.methods.getPublicProfile = function() {
  return {
    _id: this._id,
    firstName: this.firstName,
    lastName: this.lastName,
    profilePhoto: this.profilePhoto,
    verified: this.verified,
    isPremium: this.isPremium,
    userType: this.userType,
    
    // Questionnaire (public fields only)
    questionnaire: {
      city: this.questionnaire?.city,
      interests: this.questionnaire?.interests,
      ageGroup: this.questionnaire?.ageGroup,
      state: this.questionnaire?.state,
      area: this.questionnaire?.area,
      bio: this.questionnaire?.bio,
      
      // ✅ Companion fields (only if user is companion)
      ...(this.userType === 'COMPANION' && {
        becomeCompanion: this.questionnaire?.becomeCompanion,
        openFor: this.questionnaire?.openFor,
        availability: this.questionnaire?.availability,
        price: this.questionnaire?.price,
        tagline: this.questionnaire?.tagline
      })
    },
    
    // ✅ Rating stats (only for companions)
    ...(this.userType === 'COMPANION' && {
      ratingStats: this.ratingStats
    })
  };
};

/**
 * Get private profile (for user's own view)
 */
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
    
    verificationPhoto: this.verificationPhoto,
    photoVerificationStatus: this.photoVerificationStatus,
    
    questionnaire: this.questionnaire,
    
    paymentInfo: this.paymentInfo,
    ratingStats: this.ratingStats,
    profileEditStats: this.profileEditStats,
    
    // ✅ Include location info for user's own view
    last_known_lat: this.last_known_lat,
    last_known_lng: this.last_known_lng,
    last_location_updated_at: this.last_location_updated_at,
    
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    lastActive: this.lastActive
  };
};

// =============================================
// ✅ PASSWORD METHODS
// =============================================

/**
 * Hash password before saving
 */
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

/**
 * Compare password for login
 */
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

/**
 * Check if user is fully verified
 */
userSchema.methods.isFullyVerified = function() {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};

userSchema.methods.hasAcceptedCurrentLegal = async function() {
  const LegalVersion = mongoose.model('LegalVersion');
  
  const [termsDoc, privacyDoc] = await Promise.all([
    LegalVersion.findOne({ documentType: 'TERMS' }),
    LegalVersion.findOne({ documentType: 'PRIVACY' })
  ]);
  
  if (!termsDoc || !privacyDoc) {
    throw new Error('Legal versions not configured');
  }
  
  return (
    this.acceptedTermsVersion === termsDoc.currentVersion &&
    this.acceptedPrivacyVersion === privacyDoc.currentVersion &&
    !this.requiresLegalReacceptance
  );
};

/**
 * Log safety disclaimer acceptance
 */
userSchema.methods.logSafetyDisclaimer = function(bookingId, ipAddress) {
  this.safetyDisclaimerAcceptances.push({
    acceptedAt: new Date(),
    bookingId,
    ipAddress
  });
  
  // Keep only last 100 entries
  if (this.safetyDisclaimerAcceptances.length > 100) {
    this.safetyDisclaimerAcceptances = this.safetyDisclaimerAcceptances.slice(-100);
  }
  
  return this.save();
};

/**
 * Log video consent
 */
userSchema.methods.logVideoConsent = function(sessionId, ipAddress) {
  this.videoVerificationConsents.push({
    acceptedAt: new Date(),
    sessionId,
    ipAddress
  });
  
  // Keep only last 10 entries
  if (this.videoVerificationConsents.length > 10) {
    this.videoVerificationConsents = this.videoVerificationConsents.slice(-10);
  }

module.exports = mongoose.model('User', userSchema);



