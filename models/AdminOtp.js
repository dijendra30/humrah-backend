const mongoose = require('mongoose');

const adminOtpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    default: 'safety@humrah.in'
  },
  otpHash: {
    type: String,
    required: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  expiresAt: {
    type: Date,
    required: true
  }
}, { timestamps: true });

// Auto delete document after expiresAt
adminOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AdminOtp', adminOtpSchema);
