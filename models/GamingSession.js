/**
 * models/GamingSession.js
 * ─────────────────────────────────────────────────────────────
 * Mongoose schema for a Gaming Session.
 * Uses atomic $inc / $addToSet operations at the DB level
 * to guard against race conditions.
 */

const mongoose = require("mongoose");

const VALID_STATUSES = ["active", "started", "expired", "cancelled"];

const GamingSessionSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    creator_id: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },

    // ── Game details ──────────────────────────────────────────
    game_name: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 50,
    },

    // ── Player slots ─────────────────────────────────────────
    max_players: {
      type:     Number,
      required: true,
      min:      2,
      max:      6,
    },

    /**
     * Atomic counter — always equals players_list.length + 1 (creator).
     * Incremented via findOneAndUpdate with $inc to handle race conditions.
     */
    players_joined: {
      type:    Number,
      default: 1,   // creator counts as the first player
      min:     1,
    },

    players_list: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref:  "User",
      },
    ],

    // ── Location ──────────────────────────────────────────────
    city: {
      type:     String,
      required: true,
      trim:     true,
      index:    true,
    },

    // ── Timing ───────────────────────────────────────────────
    start_time: {
      type:     Date,
      required: true,
    },

    /** Computed on creation: start_time + 5 min */
    expires_at: {
      type:     Date,
      required: true,
    },

    // ── Status ───────────────────────────────────────────────
    status: {
      type:    String,
      enum:    VALID_STATUSES,
      default: "active",
      index:   true,
    },

    // ── Soft-delete: users who tapped "Not Interested" ────────
    dismissed_by: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref:  "User",
      },
    ],

    // ── Optional creator message ──────────────────────────────
    optional_message: {
      type:      String,
      maxlength: 120,
      default:   null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

// ── Compound indexes for common queries ───────────────────────
// "Give me all active sessions in Delhi sorted by start time"
GamingSessionSchema.index({ city: 1, status: 1, start_time: 1 });

// TTL index: MongoDB auto-deletes expired documents 1h after expiry
// (backup cleanup; the job handles the status change first)
GamingSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 3600 });

// ── Virtual: is the session currently full? ───────────────────
GamingSessionSchema.virtual("is_full").get(function () {
  return this.players_joined >= this.max_players;
});

// ── Virtual: spots remaining ──────────────────────────────────
GamingSessionSchema.virtual("spots_left").get(function () {
  return Math.max(0, this.max_players - this.players_joined);
});

// Include virtuals in JSON output
GamingSessionSchema.set("toJSON",   { virtuals: true });
GamingSessionSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
