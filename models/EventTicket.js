'use strict';
const mongoose = require('mongoose');
const crypto   = require('crypto');

function generateCode() {
  return 'HMR-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

const eventTicketSchema = new mongoose.Schema({
  ticketCode: {
    type: String,
    required: true,
    unique: true,
    default: generateCode
  },
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'OfficialEvent', required: true },
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',          required: true },

  // active → used (checked-in) | cancelled
  status: { type: String, enum: ['active', 'used', 'cancelled'], default: 'active' },

  checkedInAt: { type: Date, default: null },
  checkedInBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Compact JSON payload the Android app encodes into a QR code
  qrData: { type: String }
}, { timestamps: true });

// One ticket per user per event
eventTicketSchema.index({ eventId: 1, userId: 1 }, { unique: true });

// Build QR payload before first save
eventTicketSchema.pre('save', function (next) {
  if (this.isNew) {
    this.qrData = JSON.stringify({
      type:       'humrah_event_ticket',
      ticketCode: this.ticketCode,
      eventId:    this.eventId.toString(),
      userId:     this.userId.toString()
    });
  }
  next();
});

module.exports = mongoose.model('EventTicket', eventTicketSchema);
