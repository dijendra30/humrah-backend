// models/RandomBooking.js - GPS-BASED MODEL
const mongoose = require('mongoose');

const randomBookingSchema = new mongoose.Schema({
  // Creator
  initiatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true   // standalone — not in any compound, keep it
  },

  // Acceptor (set when matched)
  acceptorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true   // standalone — not in any compound, keep it
  },

  // Location (GPS-based)
  city: {
    type: String,
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ city, status, expiresAt }) below
  },

  lat: {
    type: Number,
    required: true,
    min: -90,
    max: 90,
    // ✅ FIX: index:true removed — covered by compound index({ lat, lng }) below
  },

  lng: {
    type: Number,
    required: true,
    min: -180,
    max: 180,
    // ✅ FIX: index:true removed — covered by compound index({ lat, lng }) below
  },

  locationCategory: {
    type: String,
    enum: ['Park', 'Mall', 'Cafe', 'Event Venue', 'Public Place'],
    default: 'Public Place'
  },

  // Activity
  activityType: {
    type: String,
    enum: ['WALK', 'FOOD', 'EVENT', 'EXPLORE'],
    required: true
  },

  // Time
  startTime: {
    type: Date,
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ status, startTime }) below
  },

  endTime: {
    type: Date,
    required: true
  },

  // Status
  status: {
    type: String,
    enum: ['PENDING', 'MATCHED', 'CANCELLED', 'COMPLETED', 'EXPIRED'],
    default: 'PENDING',
    required: true,
    // ✅ FIX: index:true removed — covered by compound indexes below
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    required: true,
    index: true   // standalone createdAt index — keep (not duplicated in any compound)
  },

  matchedAt:          { type: Date, default: null },
  cancelledAt:        { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  completedAt:        { type: Date, default: null },
  expiredAt:          { type: Date, default: null },

  expiresAt: {
    type: Date,
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ city, status, expiresAt }) below
  },

  // Chat reference
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBookingChat',
    default: null
  }
}, {
  timestamps: true
});

// =============================================
// ✅ INDEXES — single source of truth
// =============================================
randomBookingSchema.index({ lat: 1, lng: 1 });
randomBookingSchema.index({ city: 1, status: 1, expiresAt: 1 });
randomBookingSchema.index({ status: 1, startTime: 1 });

// =============================================
// INSTANCE METHODS
// =============================================
randomBookingSchema.methods.isExpired = function() {
  return this.expiresAt < new Date() || this.status === 'EXPIRED';
};

randomBookingSchema.methods.cancel = function(reason) {
  this.status = 'CANCELLED';
  this.cancelledAt = new Date();
  this.cancellationReason = reason || 'User cancelled';
  return this.save();
};

randomBookingSchema.methods.complete = function() {
  this.status = 'COMPLETED';
  this.completedAt = new Date();
  return this.save();
};

// =============================================
// STATIC METHODS
// =============================================
randomBookingSchema.statics.findNearby = async function(lat, lng, maxDistance = 15) {
  const { calculateDistance } = require('../utils/progressiveMatching');

  const allBookings = await this.find({
    status: 'PENDING',
    expiresAt: { $gt: new Date() },
    startTime: { $gte: new Date() }
  })
  .populate('initiatorId', 'firstName lastName profilePhoto isVerified')
  .lean();

  return allBookings
    .map(booking => {
      const distance = calculateDistance(lat, lng, booking.lat, booking.lng);
      return { ...booking, distance };
    })
    .filter(booking => booking.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);
};

randomBookingSchema.statics.cleanupExpired = async function() {
  return this.updateMany(
    { status: 'PENDING', expiresAt: { $lt: new Date() } },
    { status: 'EXPIRED', expiredAt: new Date() }
  );
};

module.exports = mongoose.model('RandomBooking', randomBookingSchema);
