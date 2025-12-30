// models/User.js - User Schema for MongoDB
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Questionnaire embedded schema
const questionnaireSchema = new mongoose.Schema({
  // ==================== ONBOARDING FIELDS (9 core questions) ====================
  name: String,
  city: String,
  languagePreference: String,
  hangoutPreferences: [String],
  availableTimes: [String],
  meetupPreference: String,
  lookingForOnHumrah: [String],
  vibeWords: [String],
  publicPlacesOnly: String,

  // ==================== PROFILE FIELDS (Progressive disclosure) ====================
  
  // Section 1: Basic Details
  ageGroup: String,
  state: String,
  area: String,

  // Section 2: About You
  bio: String,
  goodMeetupMeaning: String,
  vibeQuote: String,

  // Section 3: Lifestyle & Interests
  comfortActivity: {
  type: [String],
  default: []
},
  relaxActivity: String,
  musicPreference: String,

  // Section 4: Hangout Preferences
  budgetComfort: String,
  comfortZones: [String],
  hangoutFrequency: String,

  // Section 5: Companion Mode (Conditional)
  becomeCompanion: String,
  openFor: [String],
  availability: String,
  price: String,
  tagline: String,

  // Section 6: Trust & Safety
  verifyIdentity: String,
  understandGuidelines: String,

  // ==================== DEPRECATED/LEGACY ====================
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

  // Photo Verification
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

  // OTP Email Verification Fields
  emailVerificationOTP: { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },

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
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// =============================================
// COMPARE PASSWORD
// =============================================
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// =============================================
// VIRTUAL FULL NAME
// =============================================
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// =============================================
// CHECK IF FULLY VERIFIED (EMAIL + PHOTO)
// =============================================
userSchema.methods.isFullyVerified = function () {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};

// =============================================
// CALCULATE PROFILE COMPLETENESS
// =============================================
userSchema.virtual('profileCompleteness').get(function () {
  if (!this.questionnaire) return 40; // Only onboarding completed

  const q = this.questionnaire;
  let score = 40; // Base score from onboarding (9 essential questions)

  // SECTION 1: Basic Details (10 points)
  if (q.ageGroup) score += 3;
  if (q.state) score += 3;
  if (q.area) score += 4;

  // SECTION 2: About You (10 points)
  if (q.bio) score += 4;
  if (q.goodMeetupMeaning) score += 3;
  if (q.vibeQuote) score += 3;

  // SECTION 3: Lifestyle & Interests (10 points)
  if (q.comfortActivity) score += 3;
  if (q.relaxActivity) score += 3;
  if (q.musicPreference) score += 4;

  // SECTION 4: Hangout Preferences (10 points)
  if (q.budgetComfort) score += 3;
  if (q.comfortZones && q.comfortZones.length > 0) score += 4;
  if (q.hangoutFrequency) score += 3;

  // SECTION 5: Companion Mode (10 points)
  if (q.becomeCompanion === "Yes! I'd love to connect and earn 💰") {
    if (q.openFor && q.openFor.length > 0) score += 3;
    if (q.availability) score += 2;
    if (q.price) score += 2;
    if (q.tagline) score += 3;
  } else if (q.becomeCompanion) {
    score += 10; // Answered no, section complete
  }

  // SECTION 6: Trust & Safety (10 points)
  if (q.verifyIdentity) score += 5;
  if (q.understandGuidelines) score += 5;

  return Math.min(score, 100);
});

// =============================================
// REMOVE PASSWORD FROM JSON OUTPUT
// =============================================
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerificationOTP; // Don't expose OTP
  return obj;
};

module.exports = mongoose.model('User', userSchema);

