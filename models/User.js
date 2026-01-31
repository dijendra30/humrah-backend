// models/User.js - UPDATED with Profile System Fields
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
  
  // Role & Status
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
  // PAYMENT & EARNINGS (NEW)
  // =============================================
  paymentInfo: {
    // UPI Information
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
    
    // Earnings Tracking
    totalEarnings: { type: Number, default: 0 },        // Lifetime total
    pendingPayout: { type: Number, default: 0 },        // Awaiting transfer
    completedPayouts: { type: Number, default: 0 },     // Successfully paid
    lastPayoutDate: { type: Date, default: null },
    
    // Bank Account (optional, future use)
    bankAccount: {
      accountNumber: String,
      ifscCode: String,
      accountHolderName: String,
      isVerified: { type: Boolean, default: false }
    }
  },
  
  // =============================================
  // RATING STATISTICS (NEW)
  // =============================================
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
  
  // =============================================
  // PROFILE EDIT TRACKING (NEW)
  // =============================================
  profileEditStats: {
    lastPhotoUpdate: { type: Date, default: null },
    lastBioUpdate: { type: Date, default: null },
    lastAgeGroupUpdate: { type: Date, default: null },
    totalEdits: { type: Number, default: 0 }
  },
  
  // Profile & Photos
  profilePhoto: { type: String, default: null },
  profilePhotoPublicId: { type: String, default: null },
  
  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },
  
  // Verification
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
  
  // OAuth
  googleId: String,
  facebookId: String,
  
  // FCM Tokens
  fcmTokens: {
    type: [String],
    default: []
  },
  
  // Premium
  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },
  
  // Activity Tracking
  lastActive: { type: Date, default: Date.now },
  lastLoginIp: { type: String, default: null },
  loginAttempts: { type: Number, default: 0 },
  lockUntil: Date,
  
  // Admin fields
  suspensionInfo: {
    isSuspended: { type: Boolean, default: false },
    suspendedAt: Date,
    suspendedUntil: Date,
    suspensionReason: String,
    suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    restrictions: {
      type: [String],
      enum: ['chat', 'booking', 'posting', 'commenting'],
      default: []
    }
  },
  
  banInfo: {
    isBanned: { type: Boolean, default: false },
    bannedAt: Date,
    bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    banReason: String,
    isPermanent: { type: Boolean, default: false },
    bannedUntil: Date
  },
  
  adminNotes: [{
    note: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
  }],
  
  // =============================================
  // ACCOUNT DELETION (NEW)
  // =============================================
  deletedAt: { type: Date, default: null },
  deletionReason: { type: String, default: null },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// =============================================
// INDEXES
// =============================================
userSchema.index({ role: 1, status: 1 });
userSchema.index({ 'paymentInfo.upiStatus': 1 });
userSchema.index({ 'ratingStats.averageRating': -1 });
userSchema.index({ deletedAt: 1 });

// =============================================
// PRE-SAVE HOOKS
// =============================================
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.isFullyVerified = function () {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};

userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

userSchema.methods.incLoginAttempts = function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 }
    });
  }
  
  const updates = { $inc: { loginAttempts: 1 } };
  const maxAttempts = 5;
  const lockTime = 2 * 60 * 60 * 1000;
  
  if (this.loginAttempts + 1 >= maxAttempts && !this.isLocked()) {
    updates.$set = { lockUntil: Date.now() + lockTime };
  }
  
  return this.updateOne(updates);
};

userSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({
    $set: { loginAttempts: 0 },
    $unset: { lockUntil: 1 }
  });
};

// =============================================
// PROFILE-SPECIFIC METHODS (NEW)
// =============================================

/**
 * Get user role (Booker, Companion, or Both)
 */
userSchema.methods.getUserRole = function() {
  const isCompanion = this.questionnaire?.becomeCompanion === "Yes, I'm interested";
  const isBooker = true; // Everyone can book
  
  if (isCompanion && isBooker) return 'BOTH';
  if (isCompanion) return 'COMPANION';
  return 'BOOKER';
};

/**
 * Check if UPI is set up and verified
 */
userSchema.methods.hasVerifiedUPI = function() {
  return this.paymentInfo && this.paymentInfo.upiStatus === 'verified';
};

/**
 * Can accept companion bookings
 */
userSchema.methods.canAcceptCompanionBookings = function() {
  return this.getUserRole() !== 'BOOKER' && this.hasVerifiedUPI();
};

/**
 * Update rating statistics
 */
userSchema.methods.updateRatingStats = async function() {
  const Review = mongoose.model('Review');
  const stats = await Review.calculateRatingStats(this._id);
  
  this.ratingStats = stats;
  await this.save();
  
  return stats;
};

/**
 * Calculate earnings from a booking
 */
userSchema.methods.addEarnings = async function(amount) {
  this.paymentInfo.totalEarnings += amount;
  this.paymentInfo.pendingPayout += amount;
  this.ratingStats.completedBookings += 1;
  
  await this.save();
};

/**
 * Get public profile data
 */
userSchema.methods.getPublicProfile = function() {
  const role = this.getUserRole();
  const isCompanion = role !== 'BOOKER';
  
  const profile = {
    userId: this._id,
    firstName: this.firstName,
    lastName: this.lastName,
    profilePhoto: this.profilePhoto,
    ageRange: this.questionnaire?.ageGroup || null,
    role: role,
    isVerified: this.photoVerificationStatus === 'approved',
    memberSince: this.createdAt,
    about: {
      bio: this.questionnaire?.bio || null,
      tagline: this.questionnaire?.tagline || this.questionnaire?.vibeQuote || null,
      interests: this.questionnaire?.lookingForOnHumrah || [],
      goodMeetup: this.questionnaire?.goodMeetupMeaning || null
    }
  };
  
  // Add rating if user has enough reviews
  if (this.ratingStats.totalRatings >= 3) {
    profile.rating = {
      average: this.ratingStats.averageRating,
      totalBookings: this.ratingStats.completedBookings,
      starDistribution: this.ratingStats.starDistribution
    };
  }
  
  // Add companion-specific data
  if (isCompanion) {
    profile.availability = this.questionnaire?.availability 
      ? [this.questionnaire.availability] 
      : [];
    profile.hourlyRate = this.questionnaire?.price || null;
  }
  
  return profile;
};

/**
 * Get private profile data (for owner)
 */
userSchema.methods.getPrivateProfile = function() {
  const publicProfile = this.getPublicProfile();
  
  return {
    ...publicProfile,
    email: this.email,
    emailVerified: this.emailVerified,
    paymentInfo: this.paymentInfo ? {
      upiId: this.paymentInfo.upiId,
      upiStatus: this.paymentInfo.upiStatus,
      totalEarnings: this.paymentInfo.totalEarnings,
      pendingPayout: this.paymentInfo.pendingPayout,
      completedPayouts: this.paymentInfo.completedPayouts,
      lastPayoutDate: this.paymentInfo.lastPayoutDate
    } : null,
    profileEditStats: this.profileEditStats,
    questionnaire: this.questionnaire
  };
};

/**
 * Soft delete user account
 */
userSchema.methods.softDelete = async function(reason) {
  // Check for active bookings
  const Booking = mongoose.model('Booking');
  const activeBookings = await Booking.countDocuments({
    $or: [
      { userId: this._id },
      { companionId: this._id }
    ],
    status: { $in: ['pending', 'confirmed'] }
  });
  
  if (activeBookings > 0) {
    throw new Error('Cannot delete account with active bookings');
  }
  
  // Check for pending payouts
  if (this.paymentInfo && this.paymentInfo.pendingPayout > 0) {
    throw new Error('Cannot delete account with pending payouts. Please withdraw or forfeit.');
  }
  
  // Anonymize data
  this.firstName = 'Deleted';
  this.lastName = 'User';
  this.email = `deleted_${this._id}@humrah.local`;
  this.profilePhoto = null;
  this.profilePhotoPublicId = null;
  this.password = undefined;
  this.fcmTokens = [];
  this.status = 'DELETED';
  this.deletedAt = new Date();
  this.deletionReason = reason;
  
  await this.save();
  
  return this;
};

// =============================================
// VIRTUAL PROPERTIES
// =============================================
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

userSchema.virtual('isAdmin').get(function () {
  return this.role === 'SAFETY_ADMIN' || this.role === 'SUPER_ADMIN';
});

userSchema.virtual('profileCompleteness').get(function () {
  if (!this.questionnaire) return 40;
  const q = this.questionnaire;
  let score = 40;
  
  if (q.ageGroup) score += 3;
  if (q.state) score += 3;
  if (q.area) score += 4;
  if (q.bio) score += 4;
  if (q.goodMeetupMeaning) score += 3;
  if (q.vibeQuote) score += 3;
  if (q.comfortActivity) score += 3;
  if (q.relaxActivity) score += 3;
  if (q.musicPreference) score += 4;
  if (q.budgetComfort) score += 3;
  if (q.comfortZones && q.comfortZones.length > 0) score += 4;
  if (q.hangoutFrequency) score += 3;
  
  if (q.becomeCompanion === "Yes, I'm interested") {
    if (q.openFor && q.openFor.length > 0) score += 3;
    if (q.availability) score += 2;
    if (q.price) score += 2;
    if (q.tagline) score += 3;
  } else if (q.becomeCompanion) {
    score += 10;
  }
  
  if (q.verifyIdentity) score += 5;
  if (q.understandGuidelines) score += 5;
  
  return Math.min(score, 100);
});

// =============================================
// SANITIZE OUTPUT
// =============================================
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerificationOTP;
  delete obj.loginAttempts;
  delete obj.lockUntil;
  
  if (obj.role === 'USER') {
    delete obj.adminNotes;
  }
  
  return obj;
};

module.exports = mongoose.model('User', userSchema);
