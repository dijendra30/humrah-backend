// models/Activity.js
// Activity Feed entries — one document per event (or aggregated event).
// Retention: MongoDB TTL auto-deletes after 14 days.

const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema(
  {
    // ── Who sees this activity ──────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // ── Who caused it ───────────────────────────────────────
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Snapshot at creation time — survives even if actor deletes account
    actorName:  { type: String, default: '' },
    actorPhoto: { type: String, default: null },

    // ── Type ────────────────────────────────────────────────
    type: {
      type: String,
      enum: [
        'LIKE_POST',
        'COMMENT_POST',
        'LIKE_FOOD',
        'COMMENT_FOOD',
        'LIKE_GAMING',
        'JOIN_GAMING',
        'WARNING',
        'SYSTEM',
      ],
      required: true,
      index: true,
    },

    // ── Entity ──────────────────────────────────────────────
    entityType: {
      type: String,
      enum: ['post', 'food_post', 'gaming_session'],
      default: 'post',
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    // Thumbnail shown in the activity row (post/food imageUrl, null for gaming)
    entityImage: { type: String, default: null },

    // ── Display ─────────────────────────────────────────────
    message: { type: String, required: true },

    // ── Aggregation (likes) ──────────────────────────────────
    meta: {
      count:        { type: Number, default: 1 },
      previewUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    },

    isRead: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true, // adds createdAt + updatedAt (both returned in API responses)
  }
);

// Primary feed query index
activitySchema.index({ userId: 1, createdAt: -1 });
// TTL — auto-delete after 14 days
activitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

module.exports = mongoose.model('Activity', activitySchema);
