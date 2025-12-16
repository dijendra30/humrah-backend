// models/User.js - User Schema for MongoDB
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Updated questionnaire schema to match Android app's Questionnaire data class
const questionnaireSchema = new mongoose.Schema({
  // Basic questionnaire fields
  mood: String,
  name: String,
  ageGroup: String,
  state: String,
  city: String,
  area: String,
  languagePreference: String,
  profilePhoto: String, // Base64 encoded image
  
  // Social preferences
  personalityType: String, // introvert/extrovert/ambivert
  hangoutPreferences: [String], // Array: cafe, gaming, movie, walk, talk
  meetupPreference: String, // one-on-one or small groups
  availableTimes: [String], // morning, afternoon, evening, weekends
  
  // Intent & Mood
  lookingForOnHumrah: [String], // new friends, gaming partner, etc.
  goodMeetupMeaning: String,
  vibeWords: [String], // 3 words describing vibe
  
  // Safety
  publicPlacesOnly: String, // Yes/No
  verifyIdentity: String, // Yes/No
  understandGuidelines: String, // I agree
  
  // Personality (optional)
  comfortActivity: String,
  relaxActivity: String,
  vibeQuote: String,
  
  // Companion fields
  becomeCompanion: String,
  openFor: [String], // outdoor, gaming, coffee, group hangouts
  comfortZones: [String], // public cafes, parks, game zones
  tagline: String,
  availability: String, // Weekdays/Weekends/All Days
  price: String, // Price per hour
  
  // Legacy fields (kept for backward compatibility)
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
    required: function() {
      return !this.googleId && !this.facebookId;
    },
    minlength: [6, 'Password must be at least 6 characters']
  },
  profilePhoto: {
    type: String,
    default: null
  },
  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  premiumExpiresAt: {
    type: Date,
    default: null
  },
  verified: {
    type: Boolean,
    default: false
  },
  googleId: String,
  facebookId: String,
  lastActive: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Get full name
userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Remove password from JSON response
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
