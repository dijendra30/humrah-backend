// models/User.js - User Schema for MongoDB
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Questionnaire embedded schema
const questionnaireSchema = new mongoose.Schema({
  mood: String,
  gender: String,
  dateOfBirth: Date,
  state: String,
  city: String,
  language: String,
  languagePreference: String,
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
  profilePhoto: { type: String, default: null },

  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },

  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },

  verified: { type: Boolean, default: false },

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
  return obj;
};

module.exports = mongoose.model('User', userSchema);
