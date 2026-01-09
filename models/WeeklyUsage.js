// models/WeeklyUsage.js - FIXED (No duplicate indexes)
const mongoose = require('mongoose');

const weeklyUsageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  weekIdentifier: {
    type: String,
    required: true
  },
  
  weekStart: {
    type: Date,
    required: true
  },
  
  weekEnd: {
    type: Date,
    required: true
  },
  
  bookingsCreated: {
    type: Number,
    default: 0,
    required: true
  },
  
  cancellationCount: {
    type: Number,
    default: 0
  },
  
  noShowCount: {
    type: Number,
    default: 0
  },
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES (NO DUPLICATES)
// =============================================
weeklyUsageSchema.index({ userId: 1, weekIdentifier: 1 }, { unique: true });
// ✅ Removed duplicate weekStart index (already in compound index above)

// =============================================
// PRE-SAVE HOOK
// =============================================
weeklyUsageSchema.pre('save', function(next) {
  if (!this.weekIdentifier && this.weekStart) {
    this.weekIdentifier = generateWeekIdentifier(this.weekStart);
  }
  
  this.updatedAt = new Date();
  next();
});

// =============================================
// STATIC METHODS
// =============================================

weeklyUsageSchema.statics.getOrCreateCurrentWeek = async function(userId) {
  const { weekStart, weekEnd, weekIdentifier } = getCurrentWeek();
  
  let usage = await this.findOne({ userId, weekIdentifier });
  
  if (!usage) {
    usage = await this.create({
      userId,
      weekIdentifier,
      weekStart,
      weekEnd,
      bookingsCreated: 0,
      cancellationCount: 0,
      noShowCount: 0
    });
  }
  
  return usage;
};

weeklyUsageSchema.statics.getUserUsage = async function(userId) {
  const { weekIdentifier } = getCurrentWeek();
  return this.findOne({ userId, weekIdentifier });
};

weeklyUsageSchema.statics.canUserCreateBooking = async function(userId) {
  const { weekStart, weekEnd, weekIdentifier } = getCurrentWeek();
  
  const usage = await this.findOne({ userId, weekIdentifier });
  
  if (!usage) {
    return {
      allowed: true,
      remaining: 1,
      resetAt: weekEnd
    };
  }
  
  const remaining = Math.max(0, 1 - usage.bookingsCreated);
  
  return {
    allowed: remaining > 0,
    remaining,
    resetAt: weekEnd
  };
};

weeklyUsageSchema.statics.recordCancellation = async function(userId) {
  const { weekIdentifier } = getCurrentWeek();
  
  return this.findOneAndUpdate(
    { userId, weekIdentifier },
    { $inc: { cancellationCount: 1 } },
    { new: true, upsert: true }
  );
};

weeklyUsageSchema.statics.recordNoShow = async function(userId) {
  const { weekIdentifier } = getCurrentWeek();
  
  return this.findOneAndUpdate(
    { userId, weekIdentifier },
    { $inc: { noShowCount: 1 } },
    { new: true, upsert: true }
  );
};

weeklyUsageSchema.statics.getStatistics = async function() {
  const { weekStart, weekEnd } = getCurrentWeek();
  
  const stats = await this.aggregate([
    {
      $match: {
        weekStart: { $gte: weekStart, $lte: weekEnd }
      }
    },
    {
      $group: {
        _id: null,
        totalUsers: { $sum: 1 },
        totalBookings: { $sum: '$bookingsCreated' },
        totalCancellations: { $sum: '$cancellationCount' },
        totalNoShows: { $sum: '$noShowCount' },
        avgBookingsPerUser: { $avg: '$bookingsCreated' }
      }
    }
  ]);
  
  return stats[0] || {
    totalUsers: 0,
    totalBookings: 0,
    totalCancellations: 0,
    totalNoShows: 0,
    avgBookingsPerUser: 0
  };
};

weeklyUsageSchema.statics.cleanupOldRecords = async function() {
  const fourWeeksAgo = new Date();
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  
  const result = await this.deleteMany({
    weekStart: { $lt: fourWeeksAgo }
  });
  
  return result.deletedCount;
};

// =============================================
// HELPER FUNCTIONS
// =============================================

function getCurrentWeek() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diff);
  weekStart.setHours(0, 0, 0, 0);
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  
  const weekIdentifier = generateWeekIdentifier(weekStart);
  
  return { weekStart, weekEnd, weekIdentifier };
}

function generateWeekIdentifier(date) {
  const year = date.getFullYear();
  const weekNumber = getWeekNumber(date);
  return `${year}-${String(weekNumber).padStart(2, '0')}`;
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

module.exports = mongoose.model('WeeklyUsage', weeklyUsageSchema);
