// models/User.js - Updated User Schema for MongoDB with Profile Questions
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Questionnaire embedded schema with BOTH onboarding AND profile fields
const questionnaireSchema = new mongoose.Schema({
  // ==================== ONBOARDING FIELDS (Required at signup) ====================
  name: String,
  city: String,
  languagePreference: String,
  hangoutPreferences: [String],
  availableTimes: [String],
  meetupPreference: String,
  lookingForOnHumrah: [String],
  vibeWords: [String],
  publicPlacesOnly: String,

  // ==================== PROFILE FIELDS (Optional post-onboarding) ====================
  
  // Section 1: Basic Details
  ageGroup: String,
  state: String,
  area: String,

  // Section 2: About You
  bio: String,
  goodMeetupMeaning: String,
  vibeQuote: String,

  // Section 3: Lifestyle & Interests
  comfortActivity: String,
  relaxActivity: String,
  musicPreference: String,

  // Section 4: Hangout Preferences
  budgetComfort: String,
  comfortZones: [String],
  hangoutFrequency: String,

  // Section 5: Companion Mode
  becomeCompanion: String,
  openFor: [String],
  availability: String,
  price: String,
  tagline: String,

  // Section 6: Trust & Safety
  verifyIdentity: String,
  understandGuidelines: String,

  // ==================== DEPRECATED/LEGACY FIELDS ====================
  // Keeping these for backward compatibility
  mood: String,
  personalityType: String
}, { _id: false })

// Main User Schema
const userSchema = new mongoose.Schema({
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
  profilePhoto: { type: String, default: null },
  profilePhotoPublicId: { type: String, default: null },

  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },

  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },

  verified: { type: Boolean, default: false },
  emailVerified: { type: Boolean, default: false },

  // OTP Email Verification Fields
  emailVerificationOTP: { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },

  // Photo Verification Fields
  photoVerificationStatus: { 
    type: String, 
    enum: ['not_submitted', 'pending', 'approved', 'rejected'],
    default: 'not_submitted'
  },
  verificationPhoto: { type: String, default: null },
  verificationPhotoPublicId: { type: String, default: null },
  verificationPhotoSubmittedAt: { type: Date, default: null },
  photoVerifiedAt: { type: Date, default: null },
  photoVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  googleId: String,
  facebookId: String,

  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// =============================================
// HASH PASSWORD BEFORE SAVE
// =============================================
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// =============================================
// COMPARE PASSWORD
// =============================================
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// =============================================
// CHECK IF FULLY VERIFIED
// =============================================
userSchema.methods.isFullyVerified = function () {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};

// =============================================
// CALCULATE PROFILE COMPLETENESS
// =============================================
userSchema.methods.getProfileCompleteness = function () {
  const q = this.questionnaire;
  if (!q) return 40; // Only onboarding completed
  
  let score = 40; // Base score from onboarding
  
  // Basic Details (10 points)
  if (q.ageGroup) score += 3;
  if (q.state) score += 3;
  if (q.area) score += 4;
  
  // About You (10 points)
  if (q.bio) score += 4;
  if (q.goodMeetupMeaning) score += 3;
  if (q.vibeQuote) score += 3;
  
  // Lifestyle & Interests (10 points)
  if (q.comfortActivity) score += 3;
  if (q.relaxActivity) score += 3;
  if (q.musicPreference) score += 4;
  
  // Hangout Preferences (10 points)
  if (q.budgetComfort) score += 3;
  if (q.comfortZones?.length > 0) score += 4;
  if (q.hangoutFrequency) score += 3;
  
  // Companion Mode (10 points)
  if (q.becomeCompanion === "Yes! I'd love to connect and earn 💰") {
    if (q.openFor?.length > 0) score += 3;
    if (q.availability) score += 2;
    if (q.price) score += 2;
    if (q.tagline) score += 3;
  } else if (q.becomeCompanion) {
    score += 10; // Completed section by choosing "No"
  }
  
  // Trust & Safety (10 points)
  if (q.verifyIdentity) score += 5;
  if (q.understandGuidelines) score += 5;
  
  return Math.min(score, 100);
};

// =============================================
// VIRTUAL FULL NAME
// =============================================
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// =============================================
// VIRTUAL PROFILE COMPLETENESS
// =============================================
userSchema.virtual('profileCompleteness').get(function () {
  return this.getProfileCompleteness();
});

// =============================================
// REMOVE SENSITIVE DATA FROM JSON OUTPUT
// =============================================
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerificationOTP;
  delete obj.profilePhotoPublicId;
  delete obj.verificationPhotoPublicId;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
