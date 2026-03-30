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
  // chatExpiresAt = startTime + 3h — chat stays open for 3 hours after session starts
  chatExpiresAt: { type: Date, required: true },
  // cardExpiresAt = startTime exactly — card disappears when session begins
  // Set by the route on create: cardExpiresAt = startTime
  cardExpiresAt: { type: Date },

  // ── CARD STATUS — controls feed card only ────────────────────
  // 'waiting'  → card visible, taking players
  // 'full'     → card visible, session full
  // 'started'  → host started early
  // 'expired'  → startTime reached, card gone — chat still open
  // 'cancelled'→ host cancelled hard stop
  cardStatus: {
    type:    String,
    enum:    ['waiting', 'full', 'started', 'expired', 'cancelled'],
    default: 'waiting',
    index:   true,
  },

  // ── CHAT STATUS — controls chat access only ───────────────────
  // 'open'   → chat accessible until chatExpiresAt (startTime + 3h)
  // 'closed' → chatExpiresAt passed OR host cancelled
  // Card expiry NEVER touches this field.
  chatStatus: {
    type:    String,
    enum:    ['open', 'closed'],
    default: 'open',
    index:   true,
  },

  // Legacy status — kept for backward compat only, do not use for logic
  status: {
    type:    String,
    enum:    ["ACTIVE", "STARTED", "EXPIRED", "CANCELLED",
              "waiting_for_players", "full", "started",
              "expired", "cancelled"],
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
GamingSessionSchema.index({ cardStatus: 1, cardExpiresAt: 1 });   // card expiry query
GamingSessionSchema.index({ chatStatus: 1, chatExpiresAt: 1 });   // chat expiry query
// ✅ NO TTL INDEX — documents are kept in the database permanently.
// The card and chat expiry is managed by cardStatus/chatStatus fields only.
// MongoDB will NOT auto-delete any GamingSession documents.
// (If you want cleanup later, run a manual archival job — never a TTL here)
//
// GamingSessionSchema.index({ chatExpiresAt: 1 }, { expireAfterSeconds: ... })
// ↑ INTENTIONALLY REMOVED — TTL was deleting documents when chat ended,
//   losing all message history. Use status fields to control visibility instead.

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
