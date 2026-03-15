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
//
//  Fields per prompt §5:
//    hostId (→ creatorId), game (→ gameType), playersNeeded,
//    playersJoined, status, boostLevel, notInterestedUsers,
//    createdAt, expiresAt
//
//  Status per prompt §4:
//    waiting_for_players | full | starting | in_progress |
//    completed | expired
// ─────────────────────────────────────────────────────────────

const TEN_MIN_MS = 10 * 60 * 1000;

const GamingSessionSchema = new mongoose.Schema({

  // ── §5: hostId ────────────────────────────────────────────
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

  // ── §5: game ──────────────────────────────────────────────
  gameType: {
    type:     String,
    required: true
  },
  customGameName: {
    type:    String,
    default: null
  },

  // ── §5: playersNeeded ─────────────────────────────────────
  playersNeeded: {
    type:     Number,
    required: true,
    min:      2,
    max:      6
  },

  // ── §5: playersJoined ─────────────────────────────────────
  playersJoined: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: []
  },

  // ── §4, §5: status ────────────────────────────────────────
  status: {
    type:    String,
    enum:    [
      'waiting_for_players',  // §4
      'full',                 // §4
      'starting',             // §4
      'in_progress',          // §4
      'completed',            // §4
      'expired',              // §4
      'cancelled'             // host cancelled (§13)
    ],
    default: 'waiting_for_players',
    index:   true
  },

  // ── §5, §11: boostLevel ───────────────────────────────────
  boostLevel: {
    type:    String,
    enum:    ['normal', 'boost20', 'boost50'],
    default: 'normal'
  },

  // ── §5, §12: notInterestedUsers ───────────────────────────
  notInterestedUsers: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: []
  },

  // ── §5: expiresAt (createdAt + 10min, §4, §13) ───────────
  expiresAt: {
    type:  Date,
    index: true
  },

  // ── Like system ───────────────────────────────────────────
  likedBy: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: []
  },

  // ── Chat ──────────────────────────────────────────────────
  startTime: {
    type:     Date,
    required: true
  },
  chatExpiresAt: {
    type: Date   // startTime + 3h
  },
  kickedPlayers: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: []
  },
  mutedPlayers: {
    type:    [{
      userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      mutedUntil: { type: Date }
    }],
    default: []
  },
  pinnedMessageId: {
    type:    mongoose.Schema.Types.ObjectId,
    default: null
  },
  messages: {
    type:    [ChatMessageSchema],
    default: []
  },
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
  timestamps: true   // createdAt, updatedAt
});

// ── TTL: MongoDB auto-removes doc 3h after chatExpiresAt ──────
GamingSessionSchema.index({ chatExpiresAt: 1 }, { expireAfterSeconds: 10800 });

// ── Pre-save: auto-set expiresAt = createdAt + 10min (§4) ────
GamingSessionSchema.pre('save', function (next) {
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + TEN_MIN_MS);
  }
  next();
});

module.exports = mongoose.model('GamingSession', GamingSessionSchema);
