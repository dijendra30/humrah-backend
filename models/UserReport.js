// models/UserReport.js
const mongoose = require('mongoose');

const userReportSchema = new mongoose.Schema({
  reporterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  reportedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  reason: {
    type: String,
    required: true,
    enum: [
      'Fake profile',
      'Harassment or inappropriate behaviour',
      'Spam or promotion',
      'Unsafe behaviour',
      'Other'
    ]
  },
  description: {
    type: String,
    default: '',
    maxlength: 500
  },
  createdAt: {
    type: Date,
    default: Date.now
  },

  // Admin review (added for the admin dashboard; existing documents read as OPEN).
  // Reports are never deleted when resolved: they are safety records and feed report counts.
  status: {
    type: String,
    enum: ['OPEN', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED_BY_ADMIN', 'CLOSED'],
    default: 'OPEN'
  },
  resolutionNotes: { type: String, default: '', maxlength: 2000 },
  resolvedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt:      { type: Date, default: null },
  statusUpdatedAt: { type: Date, default: null }
});

// ── Prevent duplicate reports from same reporter → same reported user ──────────
userReportSchema.index({ reporterId: 1, reportedUserId: 1 }, { unique: true });

module.exports = mongoose.model('UserReport', userReportSchema);
