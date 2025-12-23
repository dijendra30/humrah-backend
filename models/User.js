// models/User.js - User Schema for MongoDB
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Questionnaire embedded schema
const questionnaireSchema = new mongoose.Schema({
  // Basic
  mood: String,
  name: String,
  ageGroup: String,

  // Location
  state: String,
  city: String,
  area: String,

  // Preferences
  languagePreference: String,
  personalityType: String,

  // Media
  profilePhoto: String, // base64

  // Social / meetup
  hangoutPreferences: [String],
  meetupPreference: String,
  availableTimes: [String],
  lookingForOnHumrah: [String],
  goodMeetupMeaning: String,

  // Vibe & personality
  vibeWords: [String],
  vibeQuote: String,

  // Safety & rules
  publicPlacesOnly: String,
  verifyIdentity: String,
  understandGuidelines: String,

  // Emotional
  comfortActivity: String,
  relaxActivity: String,

  // Monetization
  becomeCompanion: String,
  openFor: [String],
  comfortZones: [String],
  availability: String,
  price: String,

  // Profile
  tagline: String
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
  profilePhoto: { type: String, default: null },

  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },

  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },

  verified: { type: Boolean, default: false },

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
// HASH PASSWORD BEFORE SAVE (fixed version)
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
// REMOVE PASSWORD FROM JSON OUTPUT
// =============================================
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerificationOTP; // Don't expose OTP
  return obj;
};


module.exports = mongoose.model('User', userSchema);
