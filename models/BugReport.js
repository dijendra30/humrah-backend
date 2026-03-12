// models/BugReport.js
const mongoose = require('mongoose');

const bugReportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    category: {
      type: String,
      required: true,
      enum: ['App Crash','Something Not Working','UI Problem','Activity Issue','Chat Issue','Community Issue','Other']
    },
    description: { type: String, required: true, maxlength: 300, trim: true },
    activity:    { type: String, default: null, trim: true },
    deviceModel: { type: String, default: null },
    androidVersion: { type: String, default: null },
    appVersion:  { type: String, default: null },
    screenshotUrl: { type: String, default: null },
    status: {
      type: String,
      enum: ['open', 'in_review', 'resolved', 'closed'],
      default: 'open'
    },
    adminNote: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BugReport', bugReportSchema);
