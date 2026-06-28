const mongoose = require('mongoose');

const letterReactionSchema = new mongoose.Schema(
  {
    letterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Letter',
      required: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    type: {
      type: String,
      enum: ['helped', 'warmth'],
      required: true
    }
  },
  { timestamps: true }
);

// Unique compound index so one user can only react once to a specific letter
letterReactionSchema.index({ letterId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('LetterReaction', letterReactionSchema);
