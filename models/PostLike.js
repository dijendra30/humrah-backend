// models/PostLike.js
const mongoose = require('mongoose');

const postLikeSchema = new mongoose.Schema({
  userId: {
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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// ✅ Unique index — prevents duplicate likes at DB level
postLikeSchema.index({ userId: 1, postId: 1 }, { unique: true });

module.exports = mongoose.model('PostLike', postLikeSchema);
