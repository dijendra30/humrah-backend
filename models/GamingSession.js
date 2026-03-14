const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  SUB-SCHEMAS
// ─────────────────────────────────────────────────────────────

const ReactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  emoji:  { type: String, required: true }
}, { _id: false });

const ChatMessageSchema = new mongoose.Schema({
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderUsername: { type: String, required: true },
  senderAvatar:   { type: String, default: null },
  text:           { type: String, required: true, maxlength: 500 },
  sentAt:         { type: Date, default: Date.now },
  isPinned:       { type: Boolean, default: false },
  isSystemMsg:    { type: Boolean, default: false },
  reactions:      { type: [ReactionSchema], default: [] }
});

// ─────────────────────────────────────────────────────────────
//  GAMING SESSION SCHEMA
//  Field names match what gamingRoutes.js actually uses:
//    creatorId, creatorUsername  (NOT hostId, hostUsername)
//    req.user._id                (NOT req.user.userId)
//    status: ACTIVE | STARTED | EXPIRED | CANCELLED
//    dismissedBy                 (NOT notInterestedUsers)
// ─────────────────────────────────────────────────────────────

const GamingSessionSchema = new mongoose.Schema({

  creatorId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true
  },
  creatorUsername: {
    type:     String,
    required: true
  },
  city: {
    type:     String,
    required: true,
    index:    true
  },
  gameType: {
    type:     String,
    required: true
  },
  customGameName: {
    type:    String,
    default: null
  },
  playersNeeded: {
    type:     Number,
    required: true,
    min:      2,
    max:      6
  },
  playersJoined: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User'
  }],

  // ── Status (matches gamingRoutes.js values) ───────────────
  status: {
    type:    String,
    enum:    ['ACTIVE', 'STARTED', 'EXPIRED', 'CANCELLED'],
    default: 'ACTIVE',
    index:   true
  },

  // ── Boost level ───────────────────────────────────────────
  boostLevel: {
    type:    String,
    enum:    ['NORMAL', 'BOOST20', 'BOOST50'],
    default: 'NORMAL'
  },

  // ── Dismiss tracking (gamingRoutes uses dismissedBy) ──────
  dismissedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User'
  }],

  // ── Timing ────────────────────────────────────────────────
  startTime: {
    type:     Date,
    required: true
  },
  chatExpiresAt: {
    type: Date
  },

  // ── Host controls ─────────────────────────────────────────
  kickedPlayers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User'
  }],
  mutedPlayers: [{
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    mutedUntil: { type: Date }
  }],

  // ── Chat ──────────────────────────────────────────────────
  pinnedMessageId: {
    type:    mongoose.Schema.Types.ObjectId,
    default: null
  },
  messages: {
    type:    [ChatMessageSchema],
    default: []
  },
  // Rate limit: track last message time per userId
  lastMessageAt: {
    type:    Map,
    of:      Date,
    default: {}
  },

  optionalMessage: {
    type:      String,
    default:   null,
    maxlength: 200
  }

}, {
  timestamps: true  // createdAt, updatedAt
});

// ── TTL: auto-delete 3h after chatExpiresAt ───────────────────
GamingSessionSchema.index({ chatExpiresAt: 1 }, { expireAfterSeconds: 10800 });

module.exports = mongoose.model('GamingSession', GamingSessionSchema);
