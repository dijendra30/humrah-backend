// models/AuditLog.js - Comprehensive Audit Logging System
const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  // Actor (admin who performed the action)
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  actorRole: {
    type: String,
    enum: ['SAFETY_ADMIN', 'SUPER_ADMIN'],
    required: true
  },
  
  actorEmail: {
    type: String,
    required: true
  },
  
  // Action performed
  action: {
    type: String,
    required: true,
    index: true,
    enum: [
      // Report Actions
      'VIEW_REPORT',
      'CREATE_REPORT',
      'UPDATE_REPORT_STATUS',
      'ASSIGN_REPORT',
      'ADD_REPORT_NOTE',
      'CLOSE_REPORT',
      'REOPEN_REPORT',
      
      // Chat Actions
      'INITIATE_SUPPORT_CHAT',
      'VIEW_CHAT',
      'SEND_CHAT_MESSAGE',
      'CLOSE_CHAT',
      'REOPEN_CHAT',
      'ADD_CHAT_NOTE',
      
      // User Moderation Actions
      'VIEW_USER_PROFILE',
      'VIEW_USER_FULL_PROFILE',
      'WARN_USER',
      'SUSPEND_USER',
      'UNSUSPEND_USER',
      'BAN_USER',
      'UNBAN_USER',
      'RESTRICT_USER',
      'UNRESTRICT_USER',
      'UPDATE_USER_STATUS',
      
      // Admin Management (SUPER_ADMIN only)
      'CREATE_ADMIN',
      'UPDATE_ADMIN_ROLE',
      'UPDATE_ADMIN_PERMISSIONS',
      'DISABLE_ADMIN',
      'ENABLE_ADMIN',
      'DELETE_ADMIN',
      
      // System Actions
      'VIEW_AUDIT_LOGS',
      'EXPORT_DATA',
      'CONFIGURE_SYSTEM',
      'UPDATE_SYSTEM_SETTINGS',
      'VIEW_DASHBOARD',
      'GENERATE_REPORT',
      
      // Booking Actions
      'VIEW_BOOKING_DETAILS',
      'CANCEL_BOOKING',
      
      // Other
      'UNAUTHORIZED_ACCESS_ATTEMPT'
    ]
  },
  
  // Target (what the action was performed on)
  targetType: {
    type: String,
    enum: ['USER', 'REPORT', 'CHAT', 'MESSAGE', 'BOOKING', 'ADMIN', 'SYSTEM'],
    required: true
  },
  
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true
  },
  
  targetEmail: String,
  targetName: String,
  
  // Related resources
  relatedReportId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SafetyReport'
  },
  
  relatedChatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat'
  },
  
  relatedBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  },
  
  // Action details
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  reason: String,
  
  // Previous state (for reversible actions)
  previousState: {
    type: mongoose.Schema.Types.Mixed
  },
  
  // New state
  newState: {
    type: mongoose.Schema.Types.Mixed
  },
  
  // Request metadata
  ipAddress: String,
  userAgent: String,
  requestMethod: String,
  requestPath: String,
  
  // Response metadata
  statusCode: Number,
  responseTime: Number, // in milliseconds
  
  // Flags
  isSuccessful: {
    type: Boolean,
    default: true
  },
  
  isSensitive: {
    type: Boolean,
    default: false
  },
  
  errorMessage: String,
  
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1 });
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ isSuccessful: 1, timestamp: -1 });

// Compound indexes for common queries
auditLogSchema.index({ actorId: 1, action: 1, timestamp: -1 });
auditLogSchema.index({ targetId: 1, action: 1, timestamp: -1 });

// =============================================
// STATIC METHODS
// =============================================

/**
 * Log an admin action
 */
auditLogSchema.statics.logAction = async function (data) {
  try {
    const log = new this({
      actorId: data.actorId,
      actorRole: data.actorRole,
      actorEmail: data.actorEmail,
      action: data.action,
      targetType: data.targetType,
      targetId: data.targetId,
      targetEmail: data.targetEmail,
      targetName: data.targetName,
      relatedReportId: data.relatedReportId,
      relatedChatId: data.relatedChatId,
      relatedBookingId: data.relatedBookingId,
      details: data.details || {},
      reason: data.reason,
      previousState: data.previousState,
      newState: data.newState,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      requestMethod: data.requestMethod,
      requestPath: data.requestPath,
      statusCode: data.statusCode,
      responseTime: data.responseTime,
      isSuccessful: data.isSuccessful !== false,
      isSensitive: data.isSensitive || false,
      errorMessage: data.errorMessage
    });
    
    await log.save();
    return log;
  } catch (error) {
    console.error('Error creating audit log:', error);
    // Don't throw - we don't want audit logging to break the main action
    return null;
  }
};

/**
 * Get logs for a specific actor
 */
auditLogSchema.statics.findByActor = function (actorId, options = {}) {
  const { limit = 50, skip = 0, startDate, endDate } = options;
  
  const query = { actorId };
  
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }
  
  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .skip(skip);
};

/**
 * Get logs for a specific target
 */
auditLogSchema.statics.findByTarget = function (targetId, targetType, options = {}) {
  const { limit = 50, skip = 0 } = options;
  
  return this.find({ targetId, targetType })
    .populate('actorId', 'firstName lastName email role')
    .sort({ timestamp: -1 })
    .limit(limit)
    .skip(skip);
};

/**
 * Get logs by action type
 */
auditLogSchema.statics.findByAction = function (action, options = {}) {
  const { limit = 50, skip = 0, startDate, endDate } = options;
  
  const query = { action };
  
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }
  
  return this.find(query)
    .populate('actorId', 'firstName lastName email role')
    .sort({ timestamp: -1 })
    .limit(limit)
    .skip(skip);
};

/**
 * Get failed actions (for security monitoring)
 */
auditLogSchema.statics.findFailedActions = function (options = {}) {
  const { limit = 100, skip = 0, hours = 24 } = options;
  
  const timeAgo = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  return this.find({
    isSuccessful: false,
    timestamp: { $gte: timeAgo }
  })
  .populate('actorId', 'firstName lastName email role')
  .sort({ timestamp: -1 })
  .limit(limit)
  .skip(skip);
};

/**
 * Get unauthorized access attempts
 */
auditLogSchema.statics.findUnauthorizedAttempts = function (options = {}) {
  const { limit = 100, skip = 0, hours = 24 } = options;
  
  const timeAgo = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  return this.find({
    action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
    timestamp: { $gte: timeAgo }
  })
  .sort({ timestamp: -1 })
  .limit(limit)
  .skip(skip);
};

/**
 * Get activity statistics
 */
auditLogSchema.statics.getStatistics = async function (options = {}) {
  const { startDate, endDate } = options;
  
  const matchStage = {};
  if (startDate || endDate) {
    matchStage.timestamp = {};
    if (startDate) matchStage.timestamp.$gte = new Date(startDate);
    if (endDate) matchStage.timestamp.$lte = new Date(endDate);
  }
  
  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalActions: { $sum: 1 },
        successfulActions: {
          $sum: { $cond: ['$isSuccessful', 1, 0] }
        },
        failedActions: {
          $sum: { $cond: ['$isSuccessful', 0, 1] }
        },
        uniqueActors: { $addToSet: '$actorId' },
        actionTypes: { $addToSet: '$action' }
      }
    },
    {
      $project: {
        _id: 0,
        totalActions: 1,
        successfulActions: 1,
        failedActions: 1,
        uniqueActorsCount: { $size: '$uniqueActors' },
        actionTypesCount: { $size: '$actionTypes' }
      }
    }
  ]);
  
  return stats[0] || {
    totalActions: 0,
    successfulActions: 0,
    failedActions: 0,
    uniqueActorsCount: 0,
    actionTypesCount: 0
  };
};

/**
 * Get most active admins
 */
auditLogSchema.statics.getMostActiveAdmins = async function (limit = 10, options = {}) {
  const { startDate, endDate } = options;
  
  const matchStage = {};
  if (startDate || endDate) {
    matchStage.timestamp = {};
    if (startDate) matchStage.timestamp.$gte = new Date(startDate);
    if (endDate) matchStage.timestamp.$lte = new Date(endDate);
  }
  
  return this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$actorId',
        actorEmail: { $first: '$actorEmail' },
        actorRole: { $first: '$actorRole' },
        actionCount: { $sum: 1 },
        successfulActions: {
          $sum: { $cond: ['$isSuccessful', 1, 0] }
        }
      }
    },
    { $sort: { actionCount: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'actorDetails'
      }
    },
    { $unwind: '$actorDetails' },
    {
      $project: {
        _id: 1,
        actorName: {
          $concat: ['$actorDetails.firstName', ' ', '$actorDetails.lastName']
        },
        actorEmail: 1,
        actorRole: 1,
        actionCount: 1,
        successfulActions: 1,
        failureRate: {
          $multiply: [
            { $divide: [
              { $subtract: ['$actionCount', '$successfulActions'] },
              '$actionCount'
            ]},
            100
          ]
        }
      }
    }
  ]);
};

/**
 * Get actions by hour (for activity heatmap)
 */
auditLogSchema.statics.getActionsByHour = async function (days = 7) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  
  return this.aggregate([
    { $match: { timestamp: { $gte: startDate } } },
    {
      $group: {
        _id: {
          hour: { $hour: '$timestamp' },
          dayOfWeek: { $dayOfWeek: '$timestamp' }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.dayOfWeek': 1, '_id.hour': 1 } }
  ]);
};

/**
 * Clean old logs (data retention)
 */
auditLogSchema.statics.cleanOldLogs = async function (retentionDays = 90) {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  
  const result = await this.deleteMany({
    timestamp: { $lt: cutoffDate },
    isSensitive: false // Keep sensitive logs longer
  });
  
  console.log(`Deleted ${result.deletedCount} old audit logs`);
  return result;
};

// =============================================
// INSTANCE METHODS
// =============================================

/**
 * Get human-readable description
 */
auditLogSchema.methods.getDescription = function () {
  const actionDescriptions = {
    'VIEW_REPORT': 'viewed a safety report',
    'UPDATE_REPORT_STATUS': 'updated report status',
    'ASSIGN_REPORT': 'assigned report',
    'WARN_USER': 'warned user',
    'SUSPEND_USER': 'suspended user',
    'BAN_USER': 'banned user',
    'UNSUSPEND_USER': 'unsuspended user',
    'UNBAN_USER': 'unbanned user',
    'INITIATE_SUPPORT_CHAT': 'initiated support chat',
    'CLOSE_CHAT': 'closed chat',
    'CREATE_ADMIN': 'created admin account',
    'UPDATE_ADMIN_PERMISSIONS': 'updated admin permissions',
    'VIEW_USER_FULL_PROFILE': 'viewed full user profile'
  };
  
  const actionDesc = actionDescriptions[this.action] || this.action.toLowerCase().replace(/_/g, ' ');
  
  let description = `${this.actorEmail} ${actionDesc}`;
  
  if (this.targetName) {
    description += ` for ${this.targetName}`;
  } else if (this.targetEmail) {
    description += ` for ${this.targetEmail}`;
  }
  
  if (this.reason) {
    description += ` (${this.reason})`;
  }
  
  return description;
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
