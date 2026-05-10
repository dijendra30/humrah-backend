// models/PostReport.js
const mongoose = require('mongoose');

const postReportSchema = new mongoose.Schema(
  {
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    reportedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post',
      required: true,
      index: true
    },
    reason: {
      type: String,
      required: true,
      enum: ['Spam', 'Harassment', 'Fake Profile', 'Sexual Content', 'Scam', 'Violence', 'Other']
    },
    status: {
      type: String,
      enum: ['manual_review', 'resolved', 'dismissed'],
      default: 'manual_review',
      index: true
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    resolvedAt: {
      type: Date,
      default: null
    },
    adminNote: {
      type: String,
      default: null
    }
  },
  { timestamps: true }
);

// Prevent same user reporting same post twice
postReportSchema.index({ reportedBy: 1, postId: 1 }, { unique: true });

module.exports = mongoose.model('PostReport', postReportSchema);
