// models/RandomBooking.js - Random Booking Model (MONGOOSE WARNING FIXED)
const mongoose = require('mongoose');

const randomBookingSchema = new mongoose.Schema({
  // Initiator Information
  initiatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Booking Details
  destination: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  
  city: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  
  date: {
    type: Date,
    required: true,
    index: true
  },
  
  timeRange: {
    start: {
      type: String, // "HH:MM" format
      required: true
    },
    end: {
      type: String, // "HH:MM" format
      required: true
    }
  },
  
  // Preferences
  preferredGender: {
    type: String,
    enum: ['MALE', 'FEMALE', 'ANY'],
    required: true
  },
  
  ageRange: {
    min: {
      type: Number,
      required: true,
      min: 18,
      max: 100
    },
    max: {
      type: Number,
      required: true,
      min: 18,
      max: 100
    }
  },
  
  activityType: {
    type: String,
    enum: ['WALK', 'FOOD', 'EXPLORE', 'EVENT', 'CASUAL'],
    required: true,
    index: true
  },
  
  // Optional fields
  languagePreference: {
    type: String,
    default: null
  },
  
  note: {
    type: String,
    maxlength: 500,
    default: null
  },
  
  // Status Management
  status: {
    type: String,
    enum: ['PENDING', 'MATCHED', 'EXPIRED', 'CANCELLED'],
    default: 'PENDING',
    required: true,
    index: true
  },
  
  // Match Information
  acceptedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  
  matchedAt: {
    type: Date,
    default: null
  },
  
  // Lifecycle
  createdAt: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  },
  
  expiresAt: {
    type: Date,
    required: true,
    // ✅ REMOVED index: true FROM HERE (line 171 already creates TTL index)
  },
  
  cancelledAt: {
    type: Date,
    default: null
  },
  
  cancellationReason: {
    type: String,
    default: null
  },
  
  // Chat Reference (created after match)
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    default: null
  },
  
  // Meetup Completion
  meetupCompletedAt: {
    type: Date,
    default: null
  },
  
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Safety & Abuse Prevention
  reportedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  
  isUnderReview: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
randomBookingSchema.index({ status: 1, city: 1, date: 1 });
randomBookingSchema.index({ initiatorId: 1, createdAt: -1 });
randomBookingSchema.index({ acceptedUserId: 1, matchedAt: -1 });
randomBookingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // ✅ TTL index (only declared once)

// =============================================
// PRE-SAVE VALIDATION
// =============================================
randomBookingSchema.pre('save', function(next) {
  // Validate date is not in past
  if (this.isNew && this.date < new Date()) {
    return next(new Error('Booking date cannot be in the past'));
  }
  
  // Validate age range
  if (this.ageRange.min > this.ageRange.max) {
    return next(new Error('Minimum age cannot be greater than maximum age'));
  }
  
  // Set expiry time (24 hours from creation if no match)
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
  
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================

/**
 * Check if booking is still valid
 */
randomBookingSchema.methods.isValid = function() {
  return this.status === 'PENDING' && 
         this.expiresAt > new Date() &&
         this.date > new Date();
};

/**
 * Check if user matches preferences
 */
randomBookingSchema.methods.matchesPreferences = function(user) {
  // Check gender
  if (this.preferredGender !== 'ANY') {
    const userGender = user.questionnaire?.gender?.toUpperCase();
    if (userGender !== this.preferredGender) {
      return false;
    }
  }
  
  // Check age
  if (user.questionnaire?.dateOfBirth) {
    const age = calculateAge(user.questionnaire.dateOfBirth);
    if (age < this.ageRange.min || age > this.ageRange.max) {
      return false;
    }
  }
  
  // Check city (case-insensitive)
  const userCity = user.questionnaire?.city;
  if (!userCity || userCity.toLowerCase() !== this.city.toLowerCase()) {
    return false;
  }
  
  return true;
};

/**
 * Accept booking
 */
randomBookingSchema.methods.acceptBooking = function(userId) {
  if (this.status !== 'PENDING') {
    throw new Error('Booking is no longer available');
  }
  
  this.status = 'MATCHED';
  this.acceptedUserId = userId;
  this.matchedAt = new Date();
  
  return this.save();
};

/**
 * Cancel booking
 */
randomBookingSchema.methods.cancel = function(reason) {
  if (this.status === 'MATCHED') {
    throw new Error('Cannot cancel matched booking');
  }
  
  this.status = 'CANCELLED';
  this.cancelledAt = new Date();
  this.cancellationReason = reason;
  
  return this.save();
};

/**
 * Mark meetup as completed
 */
randomBookingSchema.methods.completeMeetup = function(userId) {
  if (this.status !== 'MATCHED') {
    throw new Error('Only matched bookings can be completed');
  }
  
  // Only initiator or accepter can mark complete
  if (userId.toString() !== this.initiatorId.toString() && 
      userId.toString() !== this.acceptedUserId.toString()) {
    throw new Error('Unauthorized to complete this booking');
  }
  
  this.meetupCompletedAt = new Date();
  this.completedBy = userId;
  
  return this.save();
};

// =============================================
// STATIC METHODS
// =============================================

/**
 * Find pending bookings for city
 */
randomBookingSchema.statics.findPendingForCity = function(city) {
  return this.find({
    status: 'PENDING',
    city: new RegExp(`^${city}$`, 'i'),
    expiresAt: { $gt: new Date() },
    date: { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

/**
 * Find eligible bookings for user
 */
randomBookingSchema.statics.findEligibleForUser = async function(user) {
  // Get user's blocked list
  const blockedUsers = user.blockedUsers || [];
  
  // Get user's city
  const userCity = user.questionnaire?.city;
  if (!userCity) return [];
  
  // Find pending bookings in same city
  const bookings = await this.find({
    status: 'PENDING',
    city: new RegExp(`^${userCity}$`, 'i'),
    expiresAt: { $gt: new Date() },
    date: { $gt: new Date() },
    initiatorId: { 
      $ne: user._id,
      $nin: blockedUsers 
    }
  })
  .populate('initiatorId', 'firstName lastName profilePhoto questionnaire')
  .sort({ createdAt: -1 });
  
  // Filter by preferences
  return bookings.filter(booking => booking.matchesPreferences(user));
};

/**
 * Get user's booking history
 */
randomBookingSchema.statics.getUserHistory = function(userId, limit = 20) {
  return this.find({
    $or: [
      { initiatorId: userId },
      { acceptedUserId: userId }
    ]
  })
  .populate('initiatorId', 'firstName lastName profilePhoto')
  .populate('acceptedUserId', 'firstName lastName profilePhoto')
  .sort({ createdAt: -1 })
  .limit(limit);
};

/**
 * Count user's bookings this week
 */
randomBookingSchema.statics.countUserBookingsThisWeek = function(userId) {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  
  return this.countDocuments({
    initiatorId: userId,
    status: { $ne: 'CANCELLED' },
    createdAt: { $gte: oneWeekAgo }
  });
};

/**
 * Cleanup expired bookings
 */
randomBookingSchema.statics.cleanupExpired = function() {
  return this.updateMany(
    {
      status: 'PENDING',
      expiresAt: { $lt: new Date() }
    },
    {
      $set: { status: 'EXPIRED' }
    }
  );
};

// =============================================
// HELPER FUNCTION
// =============================================
function calculateAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  
  return age;
}

module.exports = mongoose.model('RandomBooking', randomBookingSchema);
