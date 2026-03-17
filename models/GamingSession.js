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
  chatExpiresAt: { type: Date, required: true },   // startTime + 3h

  // Status
  status: {
    type:    String,
    enum:    [
      // ── Active states (card visible in feed) ──────────────
      'waiting_for_players',  // accepting players
      'full',                 // all spots taken
      'starting',             // host initiated start
      'in_progress',          // session underway

      // ── Post-card states (card gone, chat may still run) ──
      'live',                 // card expired from feed BUT chat still open (startTime + 3h)
                              // set by expiryJob when expiresAt passes & chatExpiresAt hasn't
      'completed',            // session ended normally

      // ── Terminal states ───────────────────────────────────
      'expired',              // card AND chat both closed (chatExpiresAt passed)
      'cancelled',            // host cancelled — hard stop, chat closes immediately

      // ── Legacy uppercase aliases (kept for old DB documents) ──
      'ACTIVE', 'STARTED', 'EXPIRED', 'CANCELLED'
    ],
    default: 'waiting_for_players',
    index:   true,
  },

  dismissedBy:   [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  optionalMessage: { type: String, maxlength: 120, default: null },

  // ── §11: boostLevel ───────────────────────────────────────
  boostLevel: {
    type:    String,
    enum:    ['normal', 'boost20', 'boost50'],
    default: 'normal'
  },

  // ── §12: notInterestedUsers ───────────────────────────────
  notInterestedUsers: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    default: []
  },

  // ── §4, §13: expiresAt = createdAt + 10min ────────────────
  // Controls when the feed card disappears (not the chat).
  // Set by pre-save hook below.
  expiresAt: {
    type:  Date,
    index: true
  },

  // ── Like system ───────────────────────────────────────────
  likedBy: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    default: []
  },

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

// ── Pre-save: auto-set expiresAt = createdAt + 10min ─────────
// expiresAt controls when the feed CARD disappears.
// The chat stays open until chatExpiresAt (startTime + 3h).
const TEN_MIN_MS = 10 * 60 * 1000;
GamingSessionSchema.pre('save', function (next) {
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + TEN_MIN_MS);
  }
  next();
});

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
