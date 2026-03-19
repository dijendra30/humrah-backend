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
    // Cloudinary public ID — used for deletion when post is removed
    imagePublicId: {
      type: String,
      default: '',
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
    // Google Places data — all optional (null = homemade food, no attached place)
    placeName: {
      type: String,
      required: false,
      maxlength: [100, 'Place name too long'],
      trim: true,
      default: null,
    },
    placeId: {
      type: String,
      required: false,
      index: true,
      default: null,
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

    // ✅ GeoJSON Point — enables $nearSphere 15 km radius queries
    // coordinates: [longitude, latitude]  ← GeoJSON order (lng first)
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
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

    // ✅ Google Places rating — fetched once at create time, stored permanently
    // null if post is homemade food or API is unavailable
    rating: {
      type: Number,
      default: null,
      min: 1,
      max: 5,
    },

    // ✅ Number of Google reviews — shown as "⭐ 4.3 (2156 reviews)"
    userRatingCount: {
      type: Number,
      default: null,
      min: 0,
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

    // ✅ Tiered visibility — MongoDB TTL hard-deletes at 48h
    //   0–24h  → fresh / high priority — always shown first in feed
    //   24–48h → stale / low priority  — shown only when no fresh posts exist nearby
    //   48h+   → TTL index auto-deletes the document from MongoDB
    expiresAt: {
      type:    Date,
      default: () => new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours
      index:   { expires: 0 }, // MongoDB TTL — auto-deletes when expiresAt passes
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

// ✅ 2dsphere index on location — required for $nearSphere 15 km radius queries
FoodPostSchema.index({ location: '2dsphere' });

// ─── Virtual: total likes count from array ────────────────────
FoodPostSchema.virtual('computedLikesCount').get(function () {
  return this.likes.length;
});

// ─── Pre-save: sync denormalized counts ───────────────────────
FoodPostSchema.pre('save', function (next) {
  // likesCount always synced from embedded likes array
  this.likesCount = this.likes.length;

  // ✅ commentsCount is NOT synced here.
  //    Comments live in the separate FoodComment collection so
  //    this.comments.length is always 0 — syncing it would reset
  //    commentsCount back to 0 on every like save. It is managed
  //    exclusively via $inc in foodController.addComment().

  // Keep GeoJSON location in sync with flat lat/lng fields
  if (this.isModified('latitude') || this.isModified('longitude') || this.isNew) {
    this.location = {
      type: 'Point',
      coordinates: [this.longitude, this.latitude], // GeoJSON: [lng, lat]
    };
  }
  next();
});

module.exports = mongoose.model('FoodPost', FoodPostSchema);
