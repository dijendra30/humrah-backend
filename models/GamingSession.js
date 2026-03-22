/**
 * models/GamingSession.js
 *
 * ── DUAL-STATUS ARCHITECTURE ─────────────────────────────────
 *
 *   cardStatus  — controls the SESSION CARD in the community feed
 *     'waiting'   card visible, accepting players
 *     'full'      card visible, all spots taken
 *     'started'   host started the session
 *     'expired'   card gone (cardExpiresAt = createdAt+10min passed)
 *     'cancelled' host cancelled hard
 *
 *   chatStatus  — controls CHAT ACCESS (completely independent)
 *     'open'      chat accessible to all members
 *     'closed'    chatExpiresAt (startTime+3h) passed, OR host cancelled
 *
 * The expiry job runs every 60 seconds:
 *   Step 1 → cardExpiresAt passed  →  cardStatus = 'expired'   (chat untouched)
 *   Step 2 → chatExpiresAt passed  →  chatStatus = 'closed'    (card untouched)
 *
 * Legacy `status` field kept for backward compat with old Android builds.
 */

const mongoose = require("mongoose");

const ReactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  emoji:  { type: String, required: true },
}, { _id: false });

const ChatMessageSchema = new mongoose.Schema({
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  senderUsername: { type: String, required: true },
  senderAvatar:   { type: String, default: null },
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

  // ── Timing ─────────────────────────────────────────────────
  startTime:     { type: Date, required: true },
  chatExpiresAt: { type: Date, required: true },   // startTime + 3h  → chat window
  cardExpiresAt: { type: Date },                   // createdAt + 10min → card window (set by pre-save)

  // ── CARD STATUS ─────────────────────────────────────────────
  // Controls ONLY the feed card — never affects chat access
  cardStatus: {
    type:    String,
    enum:    ['waiting', 'full', 'started', 'expired', 'cancelled'],
    default: 'waiting',
    index:   true,
  },

  // ── CHAT STATUS ─────────────────────────────────────────────
  // Controls ONLY chat access — never affects feed card
  chatStatus: {
    type:    String,
    enum:    ['open', 'closed'],
    default: 'open',
    index:   true,
  },

  // ── Legacy status (kept for old Android clients) ────────────
  status: {
    type:    String,
    enum:    ['waiting_for_players', 'full', 'started', 'in_progress',
              'live', 'expired', 'cancelled', 'completed',
              'ACTIVE', 'STARTED', 'EXPIRED', 'CANCELLED'],
    default: 'waiting_for_players',
  },

  // ── Extra fields ────────────────────────────────────────────
  dismissedBy:        [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  notInterestedUsers: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },
  optionalMessage:    { type: String, maxlength: 120, default: null },
  boostLevel:         { type: String, enum: ['normal', 'boost20', 'boost50'], default: 'normal' },
  likedBy:            { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },

  // ── Host powers ─────────────────────────────────────────────
  kickedPlayers:   [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  mutedPlayers:    { type: [MutedPlayerSchema], default: [] },
  pinnedMessageId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // ── Chat ────────────────────────────────────────────────────
  messages:      { type: [ChatMessageSchema], default: [] },
  lastMessageAt: { type: Map, of: Date, default: {} },

}, { timestamps: true });

// ── Indexes ─────────────────────────────────────────────────
GamingSessionSchema.index({ city: 1, cardStatus: 1, startTime: 1 });
GamingSessionSchema.index({ cardStatus: 1, cardExpiresAt: 1 });   // Step 1 expiry query
GamingSessionSchema.index({ chatStatus: 1, chatExpiresAt: 1 });   // Step 2 expiry query

// TTL: MongoDB auto-removes document 3h after chatExpiresAt
GamingSessionSchema.index({ chatExpiresAt: 1 }, { expireAfterSeconds: 3 * 60 * 60 });

// ── Pre-save: auto-set cardExpiresAt = now + 10min ──────────
const TEN_MIN_MS = 10 * 60 * 1000;
GamingSessionSchema.pre('save', function (next) {
  if (this.isNew && !this.cardExpiresAt) {
    this.cardExpiresAt = new Date(Date.now() + TEN_MIN_MS);
  }
  next();
});

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
