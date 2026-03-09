/**
 * models/GamingSession.js
 * Migrated from snake_case → camelCase to match gamingRoutes.js.
 * New fields: kickedPlayers, mutedPlayers, pinnedMessageId,
 *             chatExpiresAt, reactions, isSystemMsg, lastMessageAt
 */
const mongoose = require("mongoose");

const ReactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  emoji:  { type: String, required: true },
}, { _id: false });

const ChatMessageSchema = new mongoose.Schema({
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  senderUsername: { type: String, required: true },
  text:           { type: String, required: true, maxlength: 500 },
  sentAt:         { type: Date, default: Date.now },
  isPinned:       { type: Boolean, default: false },
  reactions:      { type: [ReactionSchema], default: [] },
  isSystemMsg:    { type: Boolean, default: false },
}, { _id: true });

const MutedPlayerSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  mutedUntil: { type: Date, required: true },
}, { _id: false });

const GamingSessionSchema = new mongoose.Schema({
  creatorId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  creatorUsername: { type: String, default: "User" },
  city:            { type: String, required: true, trim: true, index: true },
  gameType:        { type: String, required: true, trim: true },
  customGameName:  { type: String, default: null },
  playersNeeded:   { type: Number, required: true, min: 2, max: 6 },
  playersJoined:   [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

  // Timing
  startTime:     { type: Date, required: true },
  chatExpiresAt: { type: Date, required: true },   // startTime + 3h

  // Status
  status: {
    type:    String,
    enum:    ["ACTIVE", "STARTED", "EXPIRED", "CANCELLED"],
    default: "ACTIVE",
    index:   true,
  },

  dismissedBy:   [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  optionalMessage: { type: String, maxlength: 120, default: null },

  // Host powers
  kickedPlayers:   [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  mutedPlayers:    { type: [MutedPlayerSchema], default: [] },
  pinnedMessageId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Chat
  messages: { type: [ChatMessageSchema], default: [] },

  // Per-user rate limit: Map<userId → lastSentAt>
  lastMessageAt: { type: Map, of: Date, default: {} },
}, { timestamps: true });

GamingSessionSchema.index({ city: 1, status: 1, startTime: 1 });
// TTL: MongoDB auto-deletes documents 3h after chatExpiresAt
GamingSessionSchema.index({ chatExpiresAt: 1 }, { expireAfterSeconds: 3 * 60 * 60 });

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
