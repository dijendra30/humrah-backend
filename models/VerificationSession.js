// models/VerificationSession.js - Verification Session Model
const mongoose = require('mongoose');

const verificationSessionSchema = new mongoose.Schema({
  // Session Info
  sessionId: {
    type: String,
    required: true,
    unique: true,
    // ✅ FIX: unique:true already creates an index; removed redundant index:true
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ userId:1, createdAt:-1 }) below
  },

  // Instructions given to user
  instructions: {
    type: [String],
    required: true
  },

  // Video Info
  cloudinaryPublicId: { type: String, default: null },
  videoUrl:           { type: String, default: null },

  // Processing Status
  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'MANUAL_REVIEW', 'EXPIRED', 'FAILED'],
    default: 'PENDING',
    // ✅ FIX: index:true removed — covered by compound index({ status:1, createdAt:-1 }) below
  },

  result: {
    type: String,
    enum: ['APPROVED', 'REJECTED', 'MANUAL_REVIEW', null],
    default: null
  },

  // Scores
  confidence:     { type: Number, min: 0, max: 1, default: null },
  livenessScore:  { type: Number, min: 0, max: 1, default: null },
  faceMatchScore: { type: Number, min: 0, max: 1, default: null },

  // Face Embedding
  faceEmbedding: { type: [Number], default: null },

  // Rejection Info
  rejectionReason: { type: String, default: null },

  // Processing Details
  framesExtracted: { type: Number, default: 0 },
  facesDetected:   { type: Number, default: 0 },
  processingTime:  { type: Number, default: null }, // milliseconds

  // Review Info (if manual review)
  reviewedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt:   { type: Date, default: null },
  reviewNotes:  { type: String, default: null },

  // ✅ Manual review window
  manualReviewStartedAt: { type: Date, default: null },

  // ✅ 24-hour deadline from manualReviewStartedAt
  reviewDeadline: {
    type: Date,
    default: null,
    // ✅ FIX: index:true kept here ONLY (not duplicated in schema.index below)
    index: true
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    // ✅ FIX: index:true removed — covered by compound indexes below
  },

  expiresAt: {
    type: Date,
    required: true,
    // ✅ FIX: index:true removed — the explicit schema.index({ expiresAt:1 }) below
    // is the sole index. Having both index:true AND schema.index() was the duplicate.
  },

  processedAt:    { type: Date, default: null },
  videoDeletedAt: { type: Date, default: null }

}, { timestamps: true });

// =============================================
// ✅ INDEXES — single definition per field/compound
// =============================================
verificationSessionSchema.index({ userId: 1, createdAt: -1 });
verificationSessionSchema.index({ status: 1, createdAt: -1 });
// Plain expiresAt index — for TTL cleanup queries (NOT a Mongoose TTL index)
verificationSessionSchema.index({ expiresAt: 1 });

// =============================================
// METHODS
// =============================================
verificationSessionSchema.methods.isExpired = function() {
  return new Date() > this.expiresAt;
};

verificationSessionSchema.methods.markExpired = async function() {
  this.status = 'EXPIRED';
  return await this.save();
};

verificationSessionSchema.methods.getClientSummary = function() {
  return {
    sessionId:             this.sessionId,
    status:                this.status,
    result:                this.result,
    confidence:            this.confidence,
    livenessScore:         this.livenessScore,
    faceMatchScore:        this.faceMatchScore,
    rejectionReason:       this.rejectionReason,
    manualReviewStartedAt: this.manualReviewStartedAt,
    reviewDeadline:        this.reviewDeadline,
    createdAt:             this.createdAt,
    processedAt:           this.processedAt,
    expiresAt:             this.expiresAt
  };
};

// =============================================
// STATICS
// =============================================
verificationSessionSchema.statics.findActiveSession = async function(userId) {
  return await this.findOne({
    userId,
    status: 'PENDING',
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

verificationSessionSchema.statics.findPendingReviews = async function(limit = 50) {
  return await this.find({ status: 'MANUAL_REVIEW' })
    .populate('userId', 'firstName lastName email profilePhoto')
    .sort({ createdAt: -1 })
    .limit(limit);
};

verificationSessionSchema.statics.findOverdueReviews = async function() {
  return await this.find({
    status: 'MANUAL_REVIEW',
    reviewDeadline: { $lt: new Date() }
  })
  .populate('userId', 'firstName lastName email profilePhoto')
  .sort({ reviewDeadline: 1 });
};

verificationSessionSchema.statics.cleanupExpiredSessions = async function() {
  const result = await this.updateMany(
    { status: 'PENDING', expiresAt: { $lt: new Date() } },
    { $set: { status: 'EXPIRED' } }
  );
  console.log(`🧹 Cleaned up ${result.modifiedCount} expired verification sessions`);
  return result;
};

// =============================================
// HOOKS
// =============================================
verificationSessionSchema.pre('find', async function() {
  this.model.cleanupExpiredSessions().catch(err => {
    console.error('Error cleaning up expired sessions:', err);
  });
});

module.exports = mongoose.model('VerificationSession', verificationSessionSchema);
