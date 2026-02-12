// models/VerificationSession.js - Verification Session Model
const mongoose = require('mongoose');

const verificationSessionSchema = new mongoose.Schema({
  // Session Info
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Instructions given to user
  instructions: {
    type: [String],
    required: true
  },
  
  // Video Info
  cloudinaryPublicId: {
    type: String,
    default: null
  },
  
  videoUrl: {
    type: String,
    default: null
  },
  
  // Processing Status
  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'MANUAL_REVIEW', 'EXPIRED', 'FAILED'],
    default: 'PENDING',
    index: true
  },
  
  result: {
    type: String,
    enum: ['APPROVED', 'REJECTED', 'MANUAL_REVIEW', null],
    default: null
  },
  
  // Scores
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
  
  // Face Embedding (stored as array of numbers)
  faceEmbedding: {
    type: [Number],
    default: null
  },
  
  // Rejection Info
  rejectionReason: {
    type: String,
    default: null
  },
  
  // Processing Details
  framesExtracted: {
    type: Number,
    default: 0
  },
  
  facesDetected: {
    type: Number,
    default: 0
  },
  
  processingTime: {
    type: Number, // milliseconds
    default: null
  },
  
  // Review Info (if manual review)
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  reviewedAt: {
    type: Date,
    default: null
  },
  
  reviewNotes: {
    type: String,
    default: null
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  
  processedAt: {
    type: Date,
    default: null
  },
  
  videoDeletedAt: {
    type: Date,
    default: null
  }
  
}, { timestamps: true });

// =============================================
// INDEXES
// =============================================
verificationSessionSchema.index({ userId: 1, createdAt: -1 });
verificationSessionSchema.index({ status: 1, createdAt: -1 });
verificationSessionSchema.index({ expiresAt: 1 }); // For TTL cleanup

// =============================================
// METHODS
// =============================================

/**
 * Check if session is expired
 */
verificationSessionSchema.methods.isExpired = function() {
  return new Date() > this.expiresAt;
};

/**
 * Mark session as expired
 */
verificationSessionSchema.methods.markExpired = async function() {
  this.status = 'EXPIRED';
  return await this.save();
};

/**
 * Get session summary (safe for client)
 */
verificationSessionSchema.methods.getClientSummary = function() {
  return {
    sessionId: this.sessionId,
    status: this.status,
    result: this.result,
    confidence: this.confidence,
    livenessScore: this.livenessScore,
    faceMatchScore: this.faceMatchScore,
    rejectionReason: this.rejectionReason,
    createdAt: this.createdAt,
    processedAt: this.processedAt,
    expiresAt: this.expiresAt
  };
};

// =============================================
// STATICS
// =============================================

/**
 * Find active session for user
 */
verificationSessionSchema.statics.findActiveSession = async function(userId) {
  return await this.findOne({
    userId,
    status: 'PENDING',
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

/**
 * Find sessions needing manual review
 */
verificationSessionSchema.statics.findPendingReviews = async function(limit = 50) {
  return await this.find({
    status: 'MANUAL_REVIEW'
  })
  .populate('userId', 'firstName lastName email profilePhoto')
  .sort({ createdAt: -1 })
  .limit(limit);
};

/**
 * Cleanup expired sessions
 */
verificationSessionSchema.statics.cleanupExpiredSessions = async function() {
  const result = await this.updateMany(
    {
      status: 'PENDING',
      expiresAt: { $lt: new Date() }
    },
    {
      $set: { status: 'EXPIRED' }
    }
  );
  
  console.log(`🧹 Cleaned up ${result.modifiedCount} expired verification sessions`);
  return result;
};

// =============================================
// HOOKS
// =============================================

// Auto-cleanup expired sessions before find
verificationSessionSchema.pre('find', async function() {
  // Run cleanup in background (don't wait)
  this.model.cleanupExpiredSessions().catch(err => {
    console.error('Error cleaning up expired sessions:', err);
  });
});

module.exports = mongoose.model('VerificationSession', verificationSessionSchema);
