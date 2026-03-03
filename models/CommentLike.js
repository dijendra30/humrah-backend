// models/CommentLike.js
const mongoose = require('mongoose');

const commentLikeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  commentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment',
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// ✅ Unique index — prevents duplicate comment likes at DB level
commentLikeSchema.index({ userId: 1, commentId: 1 }, { unique: true });

module.exports = mongoose.model('CommentLike', commentLikeSchema);
