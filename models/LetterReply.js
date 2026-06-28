const mongoose = require('mongoose');

const letterReplySchema = new mongoose.Schema(
  {
    letterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Letter',
      required: true
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    body: {
      type: String,
      required: true,
      minlength: 5,
      maxlength: 300
    },
    isModerated: {
      type: Boolean,
      default: false
    },
    moderationReason: {
      type: String,
      default: null
    }
  },
  { timestamps: true }
);

// Indexes
letterReplySchema.index({ letterId: 1, createdAt: -1 });

module.exports = mongoose.model('LetterReply', letterReplySchema);
