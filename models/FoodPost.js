// models/FoodPost.js
// MongoDB schema for Food Discovery Posts
// These are personal community recommendations — NOT business listings

const mongoose = require('mongoose');

// ─── Comment Sub-schema ───────────────────────────────────────
const FoodCommentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  text: {
    type: String,
    required: true,
    maxlength: [200, 'Comment cannot exceed 200 characters'],
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// ─── Main FoodPost Schema ─────────────────────────────────────
const FoodPostSchema = new mongoose.Schema(
  {
    // Author
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Content
    imageUrl: {
      type: String,
      required: [true, 'A food photo is required'],
    },
    caption: {
      type: String,
      maxlength: [120, 'Caption cannot exceed 120 characters'],
      trim: true,
      default: '',
      // Validation: no URLs or phone numbers (anti-spam / anti-business-promo)
      validate: [
        {
          validator: (v) => !/https?:\/\//i.test(v),
          message: 'Caption cannot contain website links',
        },
        {
          validator: (v) => !/(\+?\d[\s\-\.]?){7,}/g.test(v),
          message: 'Caption cannot contain phone numbers',
        },
      ],
    },

    // Google Places data
    placeName: {
      type: String,
      required: [true, 'A place name is required'],
      maxlength: [100, 'Place name too long'],
      trim: true,
    },
    placeId: {
      type: String, // Google Place ID (e.g. "ChIJN1t_tDeuEmsRUs...)
      required: true,
      index: true,
    },
    latitude: {
      type: Number,
      required: true,
      min: -90,
      max: 90,
    },
    longitude: {
      type: Number,
      required: true,
      min: -180,
      max: 180,
    },

    // City-level index for "nearby" queries
    city: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // Optional price hint
    priceRange: {
      type: String,
      enum: ['₹', '₹₹', '₹₹₹', null],
      default: null,
    },

    // Engagement
    likes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    likesCount: {
      type: Number,
      default: 0,
    },
    comments: [FoodCommentSchema],
    commentsCount: {
      type: Number,
      default: 0,
    },

    // Auto-expire posts after 30 days to keep feed fresh
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      index: { expires: 0 }, // MongoDB TTL index — auto-deletes when this date passes
    },

    // Soft-delete / moderation flag
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true, // adds createdAt / updatedAt
  }
);

// ─── Compound indexes for feed queries ───────────────────────
FoodPostSchema.index({ city: 1, createdAt: -1 }); // "nearby" sorted by newest
FoodPostSchema.index({ userId: 1, createdAt: -1 }); // user's own posts

// ─── Geospatial index (optional — for radius queries) ─────────
FoodPostSchema.index({ latitude: 1, longitude: 1 });

// ─── Virtual: total likes count from array ────────────────────
FoodPostSchema.virtual('computedLikesCount').get(function () {
  return this.likes.length;
});

// ─── Pre-save: sync denormalized counts ───────────────────────
FoodPostSchema.pre('save', function (next) {
  this.likesCount = this.likes.length;
  this.commentsCount = this.comments.length;
  next();
});

module.exports = mongoose.model('FoodPost', FoodPostSchema);
