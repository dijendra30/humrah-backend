// models/RandomBooking.js - WITH AREA FIELD
const mongoose = require('mongoose');

const randomBookingSchema = new mongoose.Schema({
  initiatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  destination: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  
  // ✅ City: normalized, from user.questionnaire.city
  city: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,  // Always stored in lowercase
    index: true
  },
  
  // ✅ Area: normalized, from user.questionnaire.area (optional)
  area: {
    type: String,
    trim: true,
    lowercase: true,  // Always stored in lowercase
    default: null
  },
  
  date: {
    type: Date,
    required: true,
    index: true
  },
  
  timeRange: {
    start: {
      type: String,
      required: true
    },
    end: {
      type: String,
      required: true
    }
  },
  
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
  
  note: {
    type: String,
    maxlength: 500,
    default: null
  },
  
  status: {
    type: String,
    enum: ['PENDING', 'MATCHED', 'EXPIRED', 'CANCELLED'],
    default: 'PENDING',
    required: true,
    index: true
  },
  
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
  
  createdAt: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  },
  
  expiresAt: {
    type: Date,
    required: true
  },
  
  cancelledAt: {
    type: Date,
    default: null
  },
  
  cancellationReason: {
    type: String,
    default: null
  },
  
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    default: null
  },
  
  meetupCompletedAt: {
    type: Date,
    default: null
  },
  
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
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
// INDEXES
// =============================================
randomBookingSchema.index({ status: 1, city: 1, date: 1 });
randomBookingSchema.index({ initiatorId: 1, createdAt: -1 });
randomBookingSchema.index({ acceptedUserId: 1, matchedAt: -1 });
randomBookingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// =============================================
// PRE-SAVE VALIDATION
// =============================================
randomBookingSchema.pre('save', function(next) {
  if (this.isNew && this.date < new Date()) {
    return next(new Error('Booking date cannot be in the past'));
  }
  
  if (this.ageRange.min > this.ageRange.max) {
    return next(new Error('Minimum age cannot be greater than maximum age'));
  }
  
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
  
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================

randomBookingSchema.methods.isValid = function() {
  return this.status === 'PENDING' && 
         this.expiresAt > new Date() &&
         this.date > new Date();
};

randomBookingSchema.methods.acceptBooking = function(userId) {
  if (this.status !== 'PENDING') {
    throw new Error('Booking is no longer available');
  }
  
  this.status = 'MATCHED';
  this.acceptedUserId = userId;
  this.matchedAt = new Date();
  
  return this.save();
};

randomBookingSchema.methods.cancel = function(reason) {
  if (this.status === 'MATCHED') {
    throw new Error('Cannot cancel matched booking');
  }
  
  this.status = 'CANCELLED';
  this.cancelledAt = new Date();
  this.cancellationReason = reason;
  
  return this.save();
};

randomBookingSchema.methods.completeMeetup = function(userId) {
  if (this.status !== 'MATCHED') {
    throw new Error('Only matched bookings can be completed');
  }
  
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

randomBookingSchema.statics.getUserHistory = function(userId, limit = 20) {
  return this.find({
    $or: [
      { initiatorId: userId },
      { acceptedUserId: userId }
    ]
  })
  .populate('initiatorId', 'firstName lastName profilePhoto questionnaire')
  .populate('acceptedUserId', 'firstName lastName profilePhoto questionnaire')
  .sort({ createdAt: -1 })
  .limit(limit);
};

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

module.exports = mongoose.model('RandomBooking', randomBookingSchema);
