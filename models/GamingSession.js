/**
 * models/GamingSession.js
 * ─────────────────────────────────────────────────────────────
 * Schema uses camelCase to match gamingRoutes.js exactly.
 * Previous schema used snake_case (creator_id, game_name etc.)
 * which caused silent field-drop → ValidationError → 500.
 */

const mongoose = require("mongoose");

// ── Embedded chat message ─────────────────────────────────────
const ChatMessageSchema = new mongoose.Schema(
  {
    senderId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    senderUsername: { type: String, required: true },
    text:           { type: String, required: true, maxlength: 500 },
    sentAt:         { type: Date, default: Date.now },
  },
  { _id: true }
);

// ── Main session schema ───────────────────────────────────────
const GamingSessionSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────
    creatorId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },
    creatorUsername: {
      type:    String,
      default: "User",
    },

    // ── Location ────────────────────────────────────────────
    city: {
      type:     String,
      required: true,
      trim:     true,
      index:    true,
    },

    // ── Game details ────────────────────────────────────────
    gameType: {
      type:     String,
      required: true,
      trim:     true,
    },
    customGameName: {
      type:    String,
      default: null,
    },

    // ── Player slots ────────────────────────────────────────
    playersNeeded: {
      type:     Number,
      required: true,
      min:      2,
      max:      6,
    },
    playersJoined: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref:  "User",
      },
    ],

    // ── Timing ──────────────────────────────────────────────
    startTime: {
      type:     Date,
      required: true,
    },

    // ── Status ──────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["ACTIVE", "STARTED", "EXPIRED", "CANCELLED"],
      default: "ACTIVE",
      index:   true,
    },

    // ── Dismissed by ────────────────────────────────────────
    dismissedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref:  "User",
      },
    ],

    // ── Optional message ────────────────────────────────────
    optionalMessage: {
      type:      String,
      maxlength: 120,
      default:   null,
    },

    // ── Embedded chat messages ───────────────────────────────
    messages: {
      type:    [ChatMessageSchema],
      default: [],
    },
  },
  {
    // createdAt / updatedAt in camelCase (matches gamingRoutes formatSession)
    timestamps: true,
  }
);

// ── Compound index: city feed query ──────────────────────────
GamingSessionSchema.index({ city: 1, status: 1, startTime: 1 });

// ── TTL: auto-delete documents 1h after they expire ──────────
// expiresAt = startTime + 5min, so doc is deleted 1h after that
GamingSessionSchema.index(
  { startTime: 1 },
  { expireAfterSeconds: 5 * 60 + 60 * 60 } // 5min grace + 1h buffer
);

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
