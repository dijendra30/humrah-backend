// models/ProfileEditLog.js - Profile Edit Audit Trail
const mongoose = require('mongoose');

const profileEditLogSchema = new mongoose.Schema({
  // User who made the edit
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Field that was edited
  field: {
    type: String,
    required: true,
    index: true
  },
  
  // Old and new values
  oldValue: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  newValue: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // Metadata
  editedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  ipAddress: {
    type: String,
    required: true
  },
  
  userAgent: {
    type: String,
    default: null
  },
  
  // Optional reason (user can provide)
  changeReason: {
    type: String,
    maxlength: 200,
    default: null
  },
  
  // Fraud detection flags
  isFlagged: {
    type: Boolean,
    default: false
  },
  
  flagReason: {
    type: String,
    enum: ['rapid_edits', 'ip_change_pattern', 'suspicious_content', null],
    default: null
  }
}, { 
  timestamps: false // Using editedAt instead
});

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
// For rate limiting queries
profileEditLogSchema.index({ userId: 1, field: 1, editedAt: -1 });

// For admin queries
profileEditLogSchema.index({ isFlagged: 1, editedAt: -1 });

// For IP pattern analysis
profileEditLogSchema.index({ userId: 1, ipAddress: 1, editedAt: -1 });

// =============================================
// STATIC METHODS
// =============================================

/**
 * Log a profile edit
 */
profileEditLogSchema.statics.logEdit = async function(userId, field, oldValue, newValue, metadata = {}) {
  const log = await this.create({
    userId,
    field,
    oldValue,
    newValue,
    ipAddress: metadata.ipAddress || 'unknown',
    userAgent: metadata.userAgent || null,
    changeReason: metadata.changeReason || null
  });
  
  // Check for abuse patterns
  await this.checkForAbusePatterns(userId, field);
  
  return log;
};

/**
 * Check edit rate limit for a field
 */
profileEditLogSchema.statics.checkRateLimit = async function(userId, field) {
  const editLimits = {
    profilePhoto: { count: 1, window: 86400 },      // 1 per day
    bio: { count: 5, window: 86400 },               // 5 per day
    ageGroup: { count: 1, window: 2592000 },        // 1 per month
    state: { count: 2, window: 2592000 },           // 2 per month
    area: { count: 2, window: 2592000 },            // 2 per month
    price: { count: 10, window: 86400 },            // 10 per day
    tagline: { count: 5, window: 86400 }            // 5 per day
  };
  
  const limit = editLimits[field];
  if (!limit) {
    return { allowed: true }; // No limit for this field
  }
  
  const windowStart = new Date(Date.now() - limit.window * 1000);
  const editCount = await this.countDocuments({
    userId,
    field,
    editedAt: { $gte: windowStart }
  });
  
  if (editCount >= limit.count) {
    const resetTime = new Date(Date.now() + limit.window * 1000 - (Date.now() % (limit.window * 1000)));
    return {
      allowed: false,
      reason: `Edit limit reached for ${field}`,
      editsRemaining: 0,
      resetAt: resetTime,
      limit: limit.count,
      window: limit.window
    };
  }
  
  return {
    allowed: true,
    editsRemaining: limit.count - editCount,
    limit: limit.count,
    window: limit.window
  };
};

/**
 * Check for abuse patterns
 */
profileEditLogSchema.statics.checkForAbusePatterns = async function(userId, field) {
  // Pattern 1: Rapid edits (>5 edits in 1 hour for bio)
  if (field === 'bio' || field === 'tagline') {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentEdits = await this.countDocuments({
      userId,
      field,
      editedAt: { $gte: oneHourAgo }
    });
    
    if (recentEdits > 5) {
      await this.updateMany(
        { userId, field, editedAt: { $gte: oneHourAgo } },
        { isFlagged: true, flagReason: 'rapid_edits' }
      );
      
      // Notify admin
      const notificationService = require('../services/notification');
      await notificationService.notifyAdminOfSuspiciousActivity({
        userId,
        type: 'rapid_profile_edits',
        field,
        count: recentEdits
      });
    }
  }
  
  // Pattern 2: IP change pattern (>10 different IPs in 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentEdits = await this.find({
    userId,
    editedAt: { $gte: oneDayAgo }
  }).select('ipAddress').lean();
  
  const uniqueIPs = new Set(recentEdits.map(e => e.ipAddress));
  if (uniqueIPs.size > 10) {
    await this.updateMany(
      { userId, editedAt: { $gte: oneDayAgo } },
      { isFlagged: true, flagReason: 'ip_change_pattern' }
    );
    
    // Notify admin
    const notificationService = require('../services/notification');
    await notificationService.notifyAdminOfSuspiciousActivity({
      userId,
      type: 'ip_change_pattern',
      uniqueIPCount: uniqueIPs.size
    });
  }
};

/**
 * Get user's edit history (for user view)
 */
profileEditLogSchema.statics.getUserEditHistory = async function(userId, options = {}) {
  const { days = 30, page = 1, limit = 20 } = options;
  
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  
  const edits = await this.find({
    userId,
    editedAt: { $gte: startDate }
  })
  .select('field oldValue newValue editedAt changeReason')
  .sort({ editedAt: -1 })
  .skip((page - 1) * limit)
  .limit(limit)
  .lean();
  
  const total = await this.countDocuments({
    userId,
    editedAt: { $gte: startDate }
  });
  
  return {
    edits,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
};

/**
 * Get flagged edits for admin review
 */
profileEditLogSchema.statics.getFlaggedEdits = async function(options = {}) {
  const { page = 1, limit = 20 } = options;
  
  const edits = await this.find({ isFlagged: true })
    .populate('userId', 'firstName lastName email profilePhoto')
    .sort({ editedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  
  const total = await this.countDocuments({ isFlagged: true });
  
  // Group by user for easier review
  const groupedByUser = edits.reduce((acc, edit) => {
    const userId = edit.userId._id.toString();
    if (!acc[userId]) {
      acc[userId] = {
        user: edit.userId,
        edits: []
      };
    }
    acc[userId].edits.push(edit);
    return acc;
  }, {});
  
  return {
    edits: Object.values(groupedByUser),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
};

/**
 * Get edit statistics for a user (admin view)
 */
profileEditLogSchema.statics.getUserEditStats = async function(userId) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  
  const stats = await this.aggregate([
    {
      $match: {
        userId: mongoose.Types.ObjectId(userId),
        editedAt: { $gte: thirtyDaysAgo }
      }
    },
    {
      $group: {
        _id: '$field',
        count: { $sum: 1 },
        uniqueIPs: { $addToSet: '$ipAddress' },
        lastEdit: { $max: '$editedAt' }
      }
    }
  ]);
  
  const totalEdits = await this.countDocuments({
    userId,
    editedAt: { $gte: thirtyDaysAgo }
  });
  
  const flaggedEdits = await this.countDocuments({
    userId,
    isFlagged: true,
    editedAt: { $gte: thirtyDaysAgo }
  });
  
  return {
    totalEdits,
    flaggedEdits,
    editsByField: stats.map(s => ({
      field: s._id,
      count: s.count,
      uniqueIPCount: s.uniqueIPs.length,
      lastEdit: s.lastEdit
    })),
    period: '30 days'
  };
};

module.exports = mongoose.model('ProfileEditLog', profileEditLogSchema);
