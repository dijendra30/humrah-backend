const mongoose = require('mongoose');

const FoodCommentSchema = new mongoose.Schema(
  {
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FoodPost',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    text: {
      type: String,
      required: [true, 'Comment text is required'],
      maxlength: [120, 'Comment cannot exceed 120 characters'],
      trim: true,
      validate: [
        {
          validator: (v) => !/(\+?\d[\s\-\.]?){7,}/g.test(v),
          message: 'Comments cannot contain phone numbers',
        },
        {
          validator: (v) => !/https?:\/\//i.test(v),
          message: 'Comments cannot contain links',
        },
      ],
    },
  },
  { timestamps: true }
);

FoodCommentSchema.index({ postId: 1, createdAt: -1 });

module.exports = mongoose.model('FoodComment', FoodCommentSchema);
