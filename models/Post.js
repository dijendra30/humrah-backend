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

    // 👻 Disappearing Post Feature
    disappearMode: {
      type: String,
      enum: ['PERMANENT', 'HOUR_24', 'DAYS_3', 'WEEK', 'CUSTOM'],
      default: 'PERMANENT'
    },

    disappearHours: {
      type: Number,
      default: null // null for permanent, otherwise hours until deletion
    },

    expiresAt: {
      type: Date,
      default: null // calculated expiry date
    },

    // ✨ Vibe Mode
    vibeMode: {
      type: String,
      enum: ['NORMAL', 'FIRE', 'AESTHETIC', 'DARK', 'CHAOTIC'],
      default: 'NORMAL'
    },

    // 🔒 Privacy & Interaction Settings
    allowComments: {
      type: Boolean,
      default: true
    },

    allowLike: {
      type: Boolean,
      default: true
    },

    onlyFollowers: {
      type: Boolean,
      default: false
    },

    // 📊 Poll Feature
    hasPoll: {
      type: Boolean,
      default: false
    },

    pollQuestion: {
      type: String,
      default: null
    },

    pollOptions: [
      {
        optionText: {
          type: String,
          required: true
        },
        votes: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
          }
        ]
      }
    ],

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
    ],

    reposts: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        repostedAt: {
          type: Date,
          default: Date.now
        }
      }
    ],

    // Track if post is active (for disappearing posts)
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

// Index for automatic cleanup of expired posts
postSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Method to check if post should be visible
postSchema.methods.isVisible = function() {
  if (!this.isActive) return false;
  if (this.disappearMode === 'PERMANENT') return true;
  if (!this.expiresAt) return true;
  return new Date() < this.expiresAt;
};

// Pre-save hook to calculate expiry date
postSchema.pre('save', function(next) {
  if (this.isNew && this.disappearHours && this.disappearHours > 0) {
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + this.disappearHours);
    this.expiresAt = expiryDate;
  }
  next();
});

module.exports = mongoose.model('Post', postSchema);
