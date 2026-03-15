// models/FoodPost.js
// MongoDB schema for Food Discovery Posts
// These are personal community recommendations — NOT business listings
//
// FIXES applied vs previous version:
//  • expiresAt default: 30 days → 4 hours  (spec §2)
//  • Comment maxlength: 200 → 120 chars     (spec §9)
//  • location GeoJSON field added for $nearSphere radius queries (spec §5)

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
    maxlength: [120, 'Comment cannot exceed 120 characters'],  // ✅ fixed: was 200
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
      type: String,
      required: true,
      index: true,
    },

    // Flat lat/lng (kept for backward compat + Haversine filtering)
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

    // ✅ GeoJSON Point — enables $nearSphere / $geoWithin radius queries (spec §5)
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

    // City-level index for broad pre-filter before distance check
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
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likesCount:    { type: Number, default: 0 },
    comments:      [FoodCommentSchema],
    commentsCount: { type: Number, default: 0 },

    // ✅ Auto-expire after 4 hours (spec §2) — MongoDB TTL deletes the doc automatically
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 4 * 60 * 60 * 1000), // ✅ fixed: was 30 days
      index: { expires: 0 },
    },

    // Soft-delete / moderation flag
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────
FoodPostSchema.index({ city: 1, createdAt: -1 });
FoodPostSchema.index({ userId: 1, createdAt: -1 });
FoodPostSchema.index({ location: '2dsphere' }); // ✅ required for $nearSphere

// ─── Pre-save: sync denormalized counts + auto-populate location ──
FoodPostSchema.pre('save', function (next) {
  this.likesCount    = this.likes.length;
  this.commentsCount = this.comments.length;

  // Keep GeoJSON location in sync with flat lat/lng fields
  if (this.isModified('latitude') || this.isModified('longitude')) {
    this.location = {
      type:        'Point',
      coordinates: [this.longitude, this.latitude], // GeoJSON: [lng, lat]
    };
  }
  next();
});

module.exports = mongoose.model('FoodPost', FoodPostSchema);
