// models/Post.js  (v2 — separate like/comment collections)
const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    imageUrl:      { type: String, required: true },
    imagePublicId: { type: String, required: true },
    caption:       { type: String, default: '' },
    location:      { type: String, default: null },

    // ✅ Denormalized counters — kept in sync via $inc (atomic)
    // Never query PostLike / Comment count — read these instead.
    likeCount:    { type: Number, default: 0, min: 0 },
    commentCount: { type: Number, default: 0, min: 0 },

    // 👻 Disappearing Post
    disappearMode: {
      type: String,
      enum: ['PERMANENT', 'HOUR_24', 'DAYS_3', 'WEEK', 'CUSTOM'],
      default: 'PERMANENT'
    },
    disappearHours: { type: Number, default: null },
    expiresAt:      { type: Date,   default: null },

    // ✨ Vibe
    vibeMode: {
      type: String,
      enum: ['NORMAL', 'FIRE', 'AESTHETIC', 'DARK', 'CHAOTIC'],
      default: 'NORMAL'
    },

    // 🔒 Privacy
    allowComments: { type: Boolean, default: true },
    allowLikes:    { type: Boolean, default: true },
    onlyFollowers: { type: Boolean, default: false },

    // 📊 Poll (votes stay embedded — small fixed-size array per post)
    hasPoll:      { type: Boolean, default: false },
    pollQuestion: { type: String,  default: null },
    pollOptions: [
      {
        optionText: { type: String, required: true },
        votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
      }
    ],

    // Reposts (lightweight — just userId + timestamp, no separate collection needed)
    reposts: [
      {
        userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        repostedAt: { type: Date, default: Date.now }
      }
    ],

    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// ── Indexes ─────────────────────────────────────────────────
// Primary feed query: sort by newest, filter active
postSchema.index({ createdAt: -1 });
postSchema.index({ userId: 1, createdAt: -1 });
postSchema.index({ isActive: 1, createdAt: -1 });

// TTL index — MongoDB auto-deletes expired disappearing posts
postSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── Methods ─────────────────────────────────────────────────

postSchema.methods.isVisible = function () {
  if (!this.isActive) return false;
  if (this.disappearMode === 'PERMANENT') return true;
  if (!this.expiresAt) return true;
  return new Date() < this.expiresAt;
};

// ── Pre-save: calculate expiresAt ───────────────────────────
postSchema.pre('save', function (next) {
  if (this.isNew && this.disappearHours && this.disappearHours > 0) {
    const d = new Date();
    d.setHours(d.getHours() + this.disappearHours);
    this.expiresAt = d;
  }
  next();
});

module.exports = mongoose.model('Post', postSchema);
