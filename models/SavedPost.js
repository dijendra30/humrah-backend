const mongoose = require('mongoose');

const savedPostSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post',
      required: true
    }
  },
  { timestamps: true }
);

// Enforce unique save per user/post
savedPostSchema.index({ userId: 1, postId: 1 }, { unique: true });

// Optimize pagination queries for user's saved posts
savedPostSchema.index({ userId: 1, createdAt: -1 });

// Allow efficient cleanup when a post is deleted
savedPostSchema.index({ postId: 1 });

module.exports = mongoose.model('SavedPost', savedPostSchema);
