const mongoose = require('mongoose');

const letterAnalyticsSchema = new mongoose.Schema(
  {
    date: {
      type: String, // e.g. YYYY-MM-DD
      required: true,
      unique: true
    },
    lettersCreated: {
      type: Number,
      default: 0
    },
    lettersDeleted: {
      type: Number,
      default: 0
    },
    reportsCount: {
      type: Number,
      default: 0
    },
    repliesCount: {
      type: Number,
      default: 0
    },
    activeReaders: {
      type: Number,
      default: 0
    },
    topCategories: [
      {
        category: String,
        count: Number
      }
    ],
    topFeelings: [
      {
        feeling: String,
        count: Number
      }
    ],
    topLanguages: [
      {
        language: String,
        count: Number
      }
    ],
    highPriorityReports: {
      type: Number,
      default: 0
    },
    engagementAverage: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LetterAnalytics', letterAnalyticsSchema);
