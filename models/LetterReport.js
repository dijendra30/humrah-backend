const mongoose = require('mongoose');

const letterReportSchema = new mongoose.Schema(
  {
    letterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Letter',
      required: true
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    reason: {
      type: String,
      required: true
    },
    customReason: {
      type: String,
      default: null
    },
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'dismissed', 'removed'],
      default: 'pending'
    }
  },
  { timestamps: true }
);

// Indexes
letterReportSchema.index({ status: 1, createdAt: -1 });
letterReportSchema.index({ letterId: 1 });
letterReportSchema.index({ letterId: 1, reportedBy: 1 }, { unique: true });

module.exports = mongoose.model('LetterReport', letterReportSchema);
