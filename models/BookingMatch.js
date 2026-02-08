// models/BookingMatch.js - RECORDS SUCCESSFUL MATCHES

const mongoose = require('mongoose');

const bookingMatchSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBooking',
    required: true,
    unique: true,
    index: true
  },

  initiatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  acceptorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  matchedAt: {
    type: Date,
    default: Date.now,
    required: true
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES
// =============================================
bookingMatchSchema.index({ initiatorId: 1, matchedAt: -1 });
bookingMatchSchema.index({ acceptorId: 1, matchedAt: -1 });

module.exports = mongoose.model('BookingMatch', bookingMatchSchema);


// =============================================
// USER MODEL UPDATES REQUIRED
// =============================================
/*
Add the following fields to your existing User model:

In User schema, add:

  // Random Booking Trial
  random_trial_used: {
    type: Boolean,
    default: false,
    index: true
  },

  // GPS Location (for proximity matching)
  last_known_lat: {
    type: Number,
    min: -90,
    max: 90,
    default: null
  },

  last_known_lng: {
    type: Number,
    min: -180,
    max: 180,
    default: null
  },

  last_location_updated_at: {
    type: Date,
    default: null,
    index: true
  },

  // Behavior Metrics (for silent throttling)
  behaviorMetrics: {
    bookingsCreated: {
      type: Number,
      default: 0
    },
    bookingsAccepted: {
      type: Number,
      default: 0
    },
    bookingsCompleted: {
      type: Number,
      default: 0
    },
    cancellationCount: {
      type: Number,
      default: 0
    },
    noShowCount: {
      type: Number,
      default: 0
    },
    reportCount: {
      type: Number,
      default: 0
    }
  },

  // Account Status
  account_status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'BANNED', 'DEACTIVATED'],
    default: 'ACTIVE',
    index: true
  }

Add these indexes to User model:

  userSchema.index({ last_known_lat: 1, last_known_lng: 1 });
  userSchema.index({ random_trial_used: 1, isVerified: 1 });
  userSchema.index({ account_status: 1, last_location_updated_at: -1 });

*/
