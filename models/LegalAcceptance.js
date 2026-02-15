const mongoose = require('mongoose');

const legalAcceptanceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
    immutable: true
  },
  
  documentType: {
    type: String,
    enum: ['TERMS', 'PRIVACY', 'BOTH'],
    required: true,
    immutable: true
  },
  
  termsVersion: {
    type: String,
    required: true,
    immutable: true
  },
  
  privacyVersion: {
    type: String,
    required: true,
    immutable: true
  },
  
  acceptedAt: {
    type: Date,
    default: Date.now,
    required: true,
    immutable: true
  },
  
  ipAddress: {
    type: String,
    required: true,
    immutable: true
  },
  
  deviceFingerprint: {
    type: String,
    required: true,
    immutable: true
  },
  
  userAgent: {
    type: String,
    immutable: true
  },
  
  platform: {
    type: String,
    enum: ['ANDROID', 'IOS', 'WEB'],
    required: true,
    immutable: true
  },
  
  appVersion: {
    type: String,
    immutable: true
  }
  
}, { 
  timestamps: true
});

// Indexes for performance
legalAcceptanceSchema.index({ userId: 1, acceptedAt: -1 });
legalAcceptanceSchema.index({ termsVersion: 1, privacyVersion: 1 });

module.exports = mongoose.model('LegalAcceptance', legalAcceptanceSchema);
