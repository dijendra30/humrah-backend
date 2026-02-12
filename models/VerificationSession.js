// models/VerificationSession.js - Verification Session Model
const mongoose = require('mongoose');

const verificationSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Instructions given to user
  instructions: {
    type: [String],
    required: true
  },
  
  // Cloudinary video reference
  cloudinaryPublicId: {
    type: String,
    default: null
  },
  
  // Processing status
  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'MANUAL_REVIEW', 'EXPIRED', 'FAILED'],
    default: 'PENDING',
    index: true
  },
  
  // Result (same as status for completed sessions)
  result: {
    type: String,
    enum: ['APPROVED', 'REJECTED', 'MANUAL_REVIEW', null],
    default: null
  },
  
  // Scores and metrics
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    default: null
  },
  
  livenessScore: {
    type: Number,
    min: 0,
    max: 1,
    default: null
  },
  
  faceMatchScore: {
    type: Number,
    min: 0,
    max: 1,
    default: null
  },
  
  // Rejection reason
  rejectionReason: {
    type: String,
    default: null
  },
  
  // Face embedding (stored only if approved)
  faceEmbedding: {
    type: [Number],
    default: null
  },
  
  // Manual review info
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  reviewedAt: {
    type: Date,
    default: null
  },
  
  // Processing metadata
  processingStartedAt: {
    type: Date,
    default: null
  },
  
  processedAt: {
    type: Date,
    default: null
  },
  
  // Session expiry
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  
  // Video deletion confirmation
  videoDeleted: {
    type: Boolean,
    default: false
  },
  
  videoDeletedAt: {
    type: Date,
    default: null
  },
  
  // Fraud detection flags
  fraudFlags: {
    multipleAttempts: { type: Boolean, default: false },
    suspiciousMotion: { type: Boolean, default: false },
    photoDetected: { type: Boolean, default: false },
    duplicateFace: { type: Boolean, default: false }
  },
  
  // Metadata
  ipAddress: String,
  userAgent: String,
  deviceInfo: {
    model: String,
    osVersion: String,
    appVersion: String
  },
  
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
  
}, { timestamps: true });

// Index for efficient queries
verificationSessionSchema.index({ userId: 1, status: 1 });
verificationSessionSchema.index({ status: 1, createdAt: -1 });

// Automatically delete video when session is marked as deleted
verificationSessionSchema.pre('save', function(next) {
  if (this.isModified('videoDeleted') && this.videoDeleted && !this.videoDeletedAt) {
    this.videoDeletedAt = new Date();
  }
  next();
});

// Static method to clean up expired sessions
verificationSessionSchema.statics.cleanupExpiredSessions = async function() {
  const expiredSessions = await this.find({
    expiresAt: { $lt: new Date() },
    status: 'PENDING'
  });
  
  for (const session of expiredSessions) {
    session.status = 'EXPIRED';
    await session.save();
  }
  
  return expiredSessions.length;
};

// Static method to get user's recent verification attempts
verificationSessionSchema.statics.getUserRecentAttempts = async function(userId, hours = 24) {
  return await this.countDocuments({
    userId,
    createdAt: { $gte: new Date(Date.now() - hours * 60 * 60 * 1000) }
  });
};

module.exports = mongoose.model('VerificationSession', verificationSessionSchema);
