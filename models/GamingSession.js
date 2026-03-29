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
  senderAvatar:   { type: String, default: null },   // profilePhoto URL at send time
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
  chatExpiresAt: { type: Date, required: true },   // startTime + 3h — chat timer
  cardExpiresAt: { type: Date },                   // createdAt + 10min — card timer (set by pre-save)

  // ── CARD STATUS — controls feed card visibility only ────────
  // Set independently by the expiry job. Never read by chat logic.
  cardStatus: {
    type:    String,
    enum:    ["waiting", "full", "started", "expired", "cancelled"],
    default: "waiting",
    index:   true,
  },

  // ── CHAT STATUS — controls chat access only ───────────────
  // Set independently by the expiry job. Never read by card logic.
  // Card expiry (cardStatus="expired") NEVER touches this field.
  chatStatus: {
    type:    String,
    enum:    ["open", "closed"],
    default: "open",
    index:   true,
  },

  // Legacy status field — kept for backward compat, do not use for logic
  status: {
    type:    String,
    enum:    ["ACTIVE", "STARTED", "EXPIRED", "CANCELLED",
              "waiting_for_players", "full", "expired", "cancelled"],
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

GamingSessionSchema.index({ city: 1, cardStatus: 1, startTime: 1 });
GamingSessionSchema.index({ cardStatus: 1, cardExpiresAt: 1 });   // Step 1 expiry query
GamingSessionSchema.index({ chatStatus: 1, chatExpiresAt: 1 });   // Step 2 expiry query
// TTL: MongoDB auto-deletes document exactly at chatExpiresAt.
// chatExpiresAt = startTime + 3h, so document lives for 3h after session start.
// expireAfterSeconds: 0 means "delete at chatExpiresAt" (no extra delay).
GamingSessionSchema.index({ chatExpiresAt: 1 }, { expireAfterSeconds: 0 });

// Pre-save: auto-set cardExpiresAt = createdAt + 10min on new documents
const TEN_MIN_MS = 10 * 60 * 1000;
GamingSessionSchema.pre("save", function (next) {
  if (this.isNew && !this.cardExpiresAt) {
    this.cardExpiresAt = new Date(Date.now() + TEN_MIN_MS);
  }
  next();
});

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
