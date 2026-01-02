// models/SafetyReport.js - Enhanced Safety Report Model
const mongoose = require('mongoose');

const safetyReportSchema = new mongoose.Schema({
  // Reporter (confidential)
  reporterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Reported user
  reportedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null,
    index: true
  },
  
  // Report details
  category: {
    type: String,
    enum: [
      'HARASSMENT',
      'UNSAFE_MEETUP',
      'FAKE_PROFILE',
      'THREATENING',
      'SPAM_SCAM',
      'INAPPROPRIATE_CONTENT',
      'UNDERAGE_USER',
      'FINANCIAL_SCAM',
      'IDENTITY_THEFT',
      'OTHER'
    ],
    required: true,
    index: true
  },
  
  description: {
    type: String,
    maxlength: 2000,
    trim: true
  },
  
  evidenceUrls: [{
    type: String,
    trim: true
  }],
  
  // Contact preferences (confidential)
  contactPreference: {
    inAppChat: { type: Boolean, default: false },
    email: { type: Boolean, default: false },
    phone: { type: Boolean, default: false },
    phoneNumber: {
      type: String,
      trim: true
    }
  },
  
  // Report status
  status: {
    type: String,
    enum: [
      'PENDING',
      'UNDER_REVIEW',
      'AWAITING_INFO',
      'ACTION_TAKEN',
      'RESOLVED',
      'CLOSED',
      'REJECTED'
    ],
    default: 'PENDING',
    index: true
  },
  
  // Priority (auto-calculated or manually set)
  priority: {
    type: String,
    enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT', 'CRITICAL'],
    default: 'MEDIUM',
    index: true
  },
  
  // Assignment
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  
  assignedAt: Date,
  
  // Review information
  reviewedAt: Date,
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Actions taken
  actionsTaken: [{
    actionType: {
      type: String,
      enum: ['WARN', 'SUSPEND', 'BAN', 'RESTRICT', 'CONTACT', 'INVESTIGATE', 'DISMISS']
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    performedAt: {
      type: Date,
      default: Date.now
    },
    details: String,
    duration: String // For temporary actions
  }],
  
  // Admin notes (internal only)
  adminNotes: [{
    noteId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId()
    },
    content: {
      type: String,
      required: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    isInternal: {
      type: Boolean,
      default: true
    },
    attachments: [String]
  }],
  
  // Chat integration
  supportChatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    default: null
  },
  
  chatInitiatedAt: Date,
  chatInitiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Related resources
  relatedBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    default: null
  },
  
  relatedPostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post',
    default: null
  },
  
  // Resolution
  resolvedAt: Date,
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  resolution: String,
  resolutionCategory: {
    type: String,
    enum: ['VALID', 'INVALID', 'DUPLICATE', 'RESOLVED', 'ESCALATED']
  },
  
  // Follow-up
  requiresFollowUp: {
    type: Boolean,
    default: false
  },
  followUpDate: Date,
  followUpNotes: String,
  
  // Escalation
  isEscalated: {
    type: Boolean,
    default: false
  },
  escalatedAt: Date,
  escalatedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  escalationReason: String,
  
  // General report flag (no specific user)
  isGeneralReport: {
    type: Boolean,
    default: false
  },
  
  // Duplicate detection
  isDuplicate: {
    type: Boolean,
    default: false
  },
  originalReportId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SafetyReport'
  },
  
  // Metadata
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
safetyReportSchema.index({ reportedUserId: 1, createdAt: -1 });
safetyReportSchema.index({ status: 1, priority: -1, createdAt: -1 });
safetyReportSchema.index({ category: 1, createdAt: -1 });
safetyReportSchema.index({ assignedTo: 1, status: 1 });
safetyReportSchema.index({ reporterId: 1, createdAt: -1 });

// =============================================
// PRE-SAVE HOOKS
// =============================================
// Auto-calculate priority
safetyReportSchema.pre('save', async function (next) {
  if (this.isNew && !this.priority) {
    try {
      // Critical categories
      if (['THREATENING', 'UNDERAGE_USER', 'IDENTITY_THEFT'].includes(this.category)) {
        this.priority = 'CRITICAL';
        return next();
      }
      
      // High priority categories
      if (['HARASSMENT', 'FINANCIAL_SCAM'].includes(this.category)) {
        this.priority = 'HIGH';
      }
      
      // Check report count for this user
      if (this.reportedUserId) {
        const reportCount = await this.constructor.countDocuments({
          reportedUserId: this.reportedUserId,
          status: { $in: ['PENDING', 'UNDER_REVIEW'] }
        });
        
        if (reportCount >= 5) {
          this.priority = 'CRITICAL';
        } else if (reportCount >= 3) {
          this.priority = 'URGENT';
        } else if (reportCount >= 2) {
          this.priority = 'HIGH';
        }
      }
    } catch (error) {
      console.error('Error calculating priority:', error);
    }
  }
  next();
});

// Update timestamp
safetyReportSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================
// Add action
safetyReportSchema.methods.addAction = function (actionType, performedBy, details, duration) {
  this.actionsTaken.push({
    actionType,
    performedBy,
    details,
    duration,
    performedAt: new Date()
  });
  return this.save();
};

// Add admin note
safetyReportSchema.methods.addNote = function (content, createdBy, isInternal = true) {
  this.adminNotes.push({
    content,
    createdBy,
    isInternal,
    createdAt: new Date()
  });
  return this.save();
};

// Assign report
safetyReportSchema.methods.assignTo = function (adminId) {
  this.assignedTo = adminId;
  this.assignedAt = new Date();
  if (this.status === 'PENDING') {
    this.status = 'UNDER_REVIEW';
  }
  return this.save();
};

// Escalate report
safetyReportSchema.methods.escalate = function (escalatedTo, reason) {
  this.isEscalated = true;
  this.escalatedAt = new Date();
  this.escalatedTo = escalatedTo;
  this.escalationReason = reason;
  this.priority = 'CRITICAL';
  return this.save();
};

// Resolve report
safetyReportSchema.methods.resolve = function (resolvedBy, resolution, category) {
  this.status = 'RESOLVED';
  this.resolvedAt = new Date();
  this.resolvedBy = resolvedBy;
  this.resolution = resolution;
  this.resolutionCategory = category;
  return this.save();
};

// Close report
safetyReportSchema.methods.close = function () {
  this.status = 'CLOSED';
  return this.save();
};

// Reopen report
safetyReportSchema.methods.reopen = function () {
  this.status = 'UNDER_REVIEW';
  this.resolvedAt = null;
  this.resolvedBy = null;
  return this.save();
};

// Check if report is active
safetyReportSchema.methods.isActive = function () {
  return !['RESOLVED', 'CLOSED', 'REJECTED'].includes(this.status);
};

// Get age in days
safetyReportSchema.methods.getAgeInDays = function () {
  const now = new Date();
  const created = new Date(this.createdAt);
  const diffTime = Math.abs(now - created);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

// =============================================
// STATIC METHODS
// =============================================
// Find active reports
safetyReportSchema.statics.findActive = function () {
  return this.find({
    status: { $in: ['PENDING', 'UNDER_REVIEW', 'AWAITING_INFO'] }
  }).sort({ priority: -1, createdAt: 1 });
};

// Find by priority
safetyReportSchema.statics.findByPriority = function (priority) {
  return this.find({ priority })
    .populate('reporterId', 'firstName lastName email')
    .populate('reportedUserId', 'firstName lastName email profilePhoto')
    .populate('assignedTo', 'firstName lastName')
    .sort({ createdAt: -1 });
};

// Find assigned to admin
safetyReportSchema.statics.findAssignedTo = function (adminId) {
  return this.find({
    assignedTo: adminId,
    status: { $in: ['UNDER_REVIEW', 'AWAITING_INFO'] }
  }).sort({ priority: -1, createdAt: 1 });
};

// Find reports against user
safetyReportSchema.statics.findAgainstUser = function (userId) {
  return this.find({ reportedUserId: userId })
    .sort({ createdAt: -1 });
};

// Find reports by user
safetyReportSchema.statics.findByReporter = function (reporterId) {
  return this.find({ reporterId })
    .populate('reportedUserId', 'firstName lastName profilePhoto')
    .sort({ createdAt: -1 });
};

// Find old unresolved reports
safetyReportSchema.statics.findStaleReports = function (daysOld = 7) {
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  return this.find({
    status: { $in: ['PENDING', 'UNDER_REVIEW'] },
    createdAt: { $lt: cutoffDate }
  }).sort({ createdAt: 1 });
};

// Get statistics
safetyReportSchema.statics.getStatistics = async function () {
  const [
    total,
    pending,
    underReview,
    resolved,
    byCategory,
    byPriority,
    topReported
  ] = await Promise.all([
    this.countDocuments(),
    this.countDocuments({ status: 'PENDING' }),
    this.countDocuments({ status: 'UNDER_REVIEW' }),
    this.countDocuments({ status: 'RESOLVED' }),
    
    this.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]),
    
    this.aggregate([
      { $group: { _id: '$priority', count: { $sum: 1 } } }
    ]),
    
    this.aggregate([
      { $match: { reportedUserId: { $ne: null } } },
      {
        $group: {
          _id: '$reportedUserId',
          count: { $sum: 1 },
          latestReport: { $max: '$createdAt' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ])
  ]);
  
  return {
    total,
    pending,
    underReview,
    resolved,
    byCategory: byCategory.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
    byPriority: byPriority.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
    topReported
  };
};

module.exports = mongoose.model('SafetyReport', safetyReportSchema);
