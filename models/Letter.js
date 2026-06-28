const mongoose = require('mongoose');

const letterSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    body: {
      type: String,
      required: true,
      minlength: 10,
      maxlength: 1500
    },
    category: {
      type: String,
      required: true
    },
    feeling: {
      type: String,
      default: null
    },
    locationLabel: {
      type: String,
      required: true
    },
    authorHash: {
      type: String,
      required: true
    },
    comfortCount: {
      type: Number,
      default: 0
    },
    supportCount: {
      type: Number,
      default: 0
    },
    replyCount: {
      type: Number,
      default: 0
    },
    reportsCount: {
      type: Number,
      default: 0
    },
    viewsCount: {
      type: Number,
      default: 0
    },
    uniqueReadersCount: {
      type: Number,
      default: 0
    },
    isModerated: {
      type: Boolean,
      default: false
    },
    moderationReason: {
      type: String,
      default: null
    },
    status: {
      type: String,
      enum: ['active', 'under_review', 'removed'],
      default: 'active'
    },
    engagementScore: {
      type: Number,
      default: 0
    },
    language: {
      type: String,
      default: 'unknown'
    },
    moderationPriority: {
      type: String,
      default: 'normal'
    },
    expiresAt: {
      type: Date,
      required: true
    }
  },
  { timestamps: true }
);

// Indexes
letterSchema.index({ status: 1, createdAt: -1 });
letterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
letterSchema.index({ category: 1 });
letterSchema.index({
  body: 'text',
  category: 'text',
  feeling: 'text'
});

module.exports = mongoose.model('Letter', letterSchema);
