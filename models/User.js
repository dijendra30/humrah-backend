// models/User.js - Updated User Schema with Email & Photo Verification + OTP
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Questionnaire embedded schema
const questionnaireSchema = new mongoose.Schema({
  mood: String,
  name: String,
  ageGroup: String,
  state: String,
  city: String,
  area: String,
  languagePreference: String,
  profilePhoto: String, // Cloudinary URL
  profilePhotoPublicId: String, // Cloudinary public ID for deletion
  personalityType: String,
  hangoutPreferences: [String],
  meetupPreference: String,
  availableTimes: [String],
  lookingForOnHumrah: [String],
  goodMeetupMeaning: String,
  vibeWords: [String],
  publicPlacesOnly: String,
  verifyIdentity: String,
  understandGuidelines: String,
  comfortActivity: String,
  relaxActivity: String,
  vibeQuote: String,
  becomeCompanion: String,
  openFor: [String],
  comfortZones: [String],
  tagline: String,
  availability: String,
  price: String,
  
  // Legacy fields for backward compatibility
  gender: String,
  dateOfBirth: Date,
  language: String,
  interests: [String],
  hobbies: [String],
  musicPreference: String,
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
  bio: String
}, { _id: false });

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
  
  // Profile Photo
  profilePhoto: { 
    type: String, 
    default: null // Cloudinary URL
  },
  profilePhotoPublicId: {
    type: String,
    default: null // Cloudinary public ID
  },

  // Email Verification with OTP
  emailVerified: { 
    type: Boolean, 
    default: false 
  },
  emailVerificationOTP: { 
    type: String, 
    default: null 
  },
  emailVerificationExpires: { 
    type: Date, 
    default: null 
  },

  // Photo Verification (Manual by Admin)
  photoVerificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  photoVerifiedAt: {
    type: Date,
    default: null
  },
  photoVerifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },

  // Verification Photo (submitted for manual verification)
  verificationPhoto: {
    type: String, // Cloudinary URL
    default: null
  },
  verificationPhotoPublicId: {
    type: String, // Cloudinary public ID
    default: null
  },
  verificationPhotoSubmittedAt: {
    type: Date,
    default: null
  },

  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },

  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },

  // Overall verification status (email verified + photo approved)
  verified: { 
    type: Boolean, 
    default: false 
  },

  googleId: String,
  facebookId: String,

  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Hash password before save
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

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Virtual full name
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Check if user is fully verified (email + photo)
userSchema.methods.isFullyVerified = function() {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};

// Update overall verified status
userSchema.pre('save', function(next) {
  this.verified = this.isFullyVerified();
  next();
});

// Remove sensitive data from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerificationOTP;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
