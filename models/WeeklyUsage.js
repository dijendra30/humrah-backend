// models/WeeklyUsage.js - Track Weekly Random Booking Usage
const mongoose = require('mongoose');

const weeklyUsageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Week identifier (e.g., "2026-W01")
  weekIdentifier: {
    type: String,
    required: true,
    index: true
  },
  
  // Usage tracking
  randomBookingsCreated: {
    type: Number,
    default: 0,
    min: 0,
    max: 1 // Strict limit
  },
  
  // Abuse prevention
  cancellationCount: {
    type: Number,
    default: 0
  },
  
  noShowCount: {
    type: Number,
    default: 0
  },
  
  // Timestamps
  firstBookingAt: {
    type: Date,
    default: null
  },
  
  lastBookingAt: {
    type: Date,
    default: null
  },
  
  // Week range
  weekStart: {
    type: Date,
    required: true
  },
  
  weekEnd: {
    type: Date,
    required: true
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
// COMPOUND INDEX (Unique per user per week)
// =============================================
weeklyUsageSchema.index({ userId: 1, weekIdentifier: 1 }, { unique: true });

// =============================================
// STATIC METHODS
// =============================================

/**
 * Get current week identifier
 */
weeklyUsageSchema.statics.getCurrentWeekIdentifier = function() {
  const now = new Date();
  const year = now.getFullYear();
  const week = getWeekNumber(now);
  return `${year}-W${String(week).padStart(2, '0')}`;
};

/**
 * Get week start and end dates
 */
weeklyUsageSchema.statics.getWeekRange = function(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  
  const weekStart = new Date(d.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  
  return { weekStart, weekEnd };
};

/**
 * Check if user can create random booking this week
 */
weeklyUsageSchema.statics.canUserCreateBooking = async function(userId) {
  const weekIdentifier = this.getCurrentWeekIdentifier();
  
  const usage = await this.findOne({ userId, weekIdentifier });
  
  // No usage record = can create
  if (!usage) return { allowed: true, remaining: 1 };
  
  // Check if limit reached
  if (usage.randomBookingsCreated >= 1) {
    return { 
      allowed: false, 
      remaining: 0,
      resetAt: usage.weekEnd
    };
  }
  
  return { 
    allowed: true, 
    remaining: 1 - usage.randomBookingsCreated 
  };
};

/**
 * Record booking creation
 */
weeklyUsageSchema.statics.recordBooking = async function(userId) {
  const weekIdentifier = this.getCurrentWeekIdentifier();
  const { weekStart, weekEnd } = this.getWeekRange();
  
  const usage = await this.findOneAndUpdate(
    { userId, weekIdentifier },
    {
      $inc: { randomBookingsCreated: 1 },
      $set: { 
        lastBookingAt: new Date(),
        weekStart,
        weekEnd
      },
      $setOnInsert: { 
        firstBookingAt: new Date(),
        weekStart,
        weekEnd
      }
    },
    {
      upsert: true,
      new: true
    }
  );
  
  return usage;
};

/**
 * Record cancellation
 */
weeklyUsageSchema.statics.recordCancellation = async function(userId) {
  const weekIdentifier = this.getCurrentWeekIdentifier();
  const { weekStart, weekEnd } = this.getWeekRange();
  
  return this.findOneAndUpdate(
    { userId, weekIdentifier },
    {
      $inc: { cancellationCount: 1 },
      $setOnInsert: { weekStart, weekEnd }
    },
    {
      upsert: true,
      new: true
    }
  );
};

/**
 * Record no-show
 */
weeklyUsageSchema.statics.recordNoShow = async function(userId) {
  const weekIdentifier = this.getCurrentWeekIdentifier();
  const { weekStart, weekEnd } = this.getWeekRange();
  
  return this.findOneAndUpdate(
    { userId, weekIdentifier },
    {
      $inc: { noShowCount: 1 },
      $setOnInsert: { weekStart, weekEnd }
    },
    {
      upsert: true,
      new: true
    }
  );
};

/**
 * Get user's usage for current week
 */
weeklyUsageSchema.statics.getUserUsage = function(userId) {
  const weekIdentifier = this.getCurrentWeekIdentifier();
  return this.findOne({ userId, weekIdentifier });
};

/**
 * Get usage statistics
 */
weeklyUsageSchema.statics.getStatistics = async function() {
  const weekIdentifier = this.getCurrentWeekIdentifier();
  
  const stats = await this.aggregate([
    { $match: { weekIdentifier } },
    {
      $group: {
        _id: null,
        totalUsers: { $sum: 1 },
        totalBookings: { $sum: '$randomBookingsCreated' },
        totalCancellations: { $sum: '$cancellationCount' },
        totalNoShows: { $sum: '$noShowCount' },
        usersAtLimit: {
          $sum: { $cond: [{ $gte: ['$randomBookingsCreated', 1] }, 1, 0] }
        }
      }
    }
  ]);
  
  return stats[0] || {
    totalUsers: 0,
    totalBookings: 0,
    totalCancellations: 0,
    totalNoShows: 0,
    usersAtLimit: 0
  };
};

// =============================================
// HELPER FUNCTION
// =============================================
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

module.exports = mongoose.model('WeeklyUsage', weeklyUsageSchema);
