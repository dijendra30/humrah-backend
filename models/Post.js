// models/Post.js
const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    imageUrl: {
      type: String,
      required: true
    },

    imagePublicId: {
      type: String,
      required: true
    },

    caption: {
      type: String,
      default: ''
    },

    location: {
      type: String,
      default: null
    },

    musicTrack: {
      type: String,
      default: null
    },

    likes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    ],

    comments: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        text: String,
        createdAt: {
          type: Date,
          default: Date.now
        }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Post', postSchema);
