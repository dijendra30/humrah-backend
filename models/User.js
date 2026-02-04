// models/User.js - UPDATED with MEMBER/COMPANION User Type System
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
  
  // =============================================
  // ✅ NEW: USER TYPE SYSTEM
  // =============================================
  /**
   * User Type - Determines if user is a companion or member
   * - MEMBER: Regular user looking for companions
   * - COMPANION: User offering companionship services
   * 
   * This is SEPARATE from role (which is for admin access)
   * 
   * Auto-determined from questionnaire.becomeCompanion:
   * - "Yes, I'm interested" → COMPANION
   * - Anything else → MEMBER
   */
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
  
  // Continue with rest of schema...
  // [Previous User schema fields remain exactly the same]
  
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
// ✅ MIDDLEWARE: Auto-update userType based on questionnaire
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
// EXISTING METHODS (Keep all existing methods)
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
    userType: this.userType, // ✅ NEW: Include userType
    
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
    userType: this.userType, // ✅ NEW
    
    verificationPhoto: this.verificationPhoto,
    photoVerificationStatus: this.photoVerificationStatus,
    
    questionnaire: this.questionnaire,
    
    paymentInfo: this.paymentInfo,
    ratingStats: this.ratingStats,
    profileEditStats: this.profileEditStats,
    
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    lastActive: this.lastActive
  };
};

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

module.exports = mongoose.model('User', userSchema);
