// models/BookingMatch.js - RECORDS SUCCESSFUL MATCHES
const mongoose = require('mongoose');

const bookingMatchSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBooking',
    required: true,
    unique: true,
    // ✅ FIX: removed index:true — unique:true already creates an index automatically.
    // Having both unique:true AND index:true was the cause of the duplicate warning.
  },

  initiatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: removed index:true — covered by compound index({ initiatorId, matchedAt }) below
  },

  acceptorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: removed index:true — covered by compound index({ acceptorId, matchedAt }) below
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
// INDEXES — single source of truth
// =============================================
bookingMatchSchema.index({ initiatorId: 1, matchedAt: -1 });
bookingMatchSchema.index({ acceptorId: 1, matchedAt: -1 });

module.exports = mongoose.model('BookingMatch', bookingMatchSchema);
